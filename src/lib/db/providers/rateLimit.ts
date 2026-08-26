/**
 * db/providers/rateLimit.ts — Rate-limit/quota runtime helpers for provider_connections.
 */

import { getDbInstance } from "../core";
import { invalidateDbCache } from "../readCache";

interface StatementLike<TRow = unknown> {
  all: (...params: unknown[]) => TRow[];
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
}

// ──────────────── T05: Rate-Limit DB Persistence ──────────────────────────
// Allows rate-limit state to survive token refresh without being accidentally
// cleared. DB column rate_limited_until already exists in schema.
// Ref: sub2api PR #1218 (fix(openai): prevent rescheduling rate-limited accounts)

/**
 * T05: Persist when a connection is rate-limited, directly in DB.
 * This survives token refresh — OAuth flows must NOT override this field.
 *
 * @param connectionId - The provider_connections.id
 * @param until - Epoch ms when the rate limit expires (null to clear)
 */
export function setConnectionRateLimitUntil(connectionId: string, until: number | null): void {
  const db = getDbInstance() as unknown as DbLike;
  db.prepare(
    "UPDATE provider_connections SET rate_limited_until = ?, updated_at = ? WHERE id = ?"
  ).run(until, new Date().toISOString(), connectionId);
  invalidateDbCache("connections");
}

/**
 * Mark a connection as rate-limited until `Date.now() + retryAfterMs`.
 *
 * Best-effort: never throws — a DB failure must not crash the chat path. The T05
 * startup helper `clearStaleCrashCooldowns` will not undo a write made here because
 * the timestamp is always strictly in the future at the moment of write. See Issue #1
 * (per-account 429 cascade not persisting).
 */
export function markConnectionRateLimitedUntil(connectionId: string, retryAfterMs: number): void {
  if (typeof connectionId !== "string" || connectionId.length === 0) return;
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return;
  try {
    setConnectionRateLimitUntil(connectionId, Date.now() + retryAfterMs);
  } catch {
    // best-effort
  }
}

/**
 * Clear a connection's persisted 429 cooldown.
 *
 * Best-effort: never throws. Mirrors `resetAccountState`'s in-memory clear so the
 * in-memory AccountState and the DB row agree.
 */
export function clearConnectionRateLimit(connectionId: string): void {
  if (typeof connectionId !== "string" || connectionId.length === 0) return;
  try {
    setConnectionRateLimitUntil(connectionId, null);
  } catch {
    // best-effort
  }
}

/**
 * T05: Check if a connection is currently rate-limited (DB-backed).
 * Use this before account selection to skip transiently rate-limited accounts.
 *
 * @returns true if rate_limited_until is set and in the future
 */
export function isConnectionRateLimited(connectionId: string): boolean {
  const db = getDbInstance() as unknown as DbLike;
  const row = db
    .prepare("SELECT rate_limited_until FROM provider_connections WHERE id = ?")
    .get(connectionId) as { rate_limited_until?: number | null } | undefined;
  if (!row?.rate_limited_until) return false;
  return Date.now() < row.rate_limited_until;
}

/**
 * T05: Get all connections for a provider that are currently rate-limited.
 * Returns an array of { id, rateLimitedUntil } for dashboard display.
 */
export function getRateLimitedConnections(
  provider: string
): Array<{ id: string; rateLimitedUntil: number }> {
  const db = getDbInstance() as unknown as DbLike;
  const now = Date.now();
  const rows = db
    .prepare(
      "SELECT id, rate_limited_until FROM provider_connections WHERE provider = ? AND rate_limited_until > ?"
    )
    .all(provider, now) as Array<{ id: string; rate_limited_until: number }>;
  return rows.map((r) => ({ id: r.id, rateLimitedUntil: r.rate_limited_until }));
}

/**
 * Clear Antigravity connection-wide cooldowns written by the former
 * model-quota path. Safe only for active rows with no terminal/auth evidence;
 * model/family lockouts remain in the in-memory lockout layer.
 */
export function clearLegacyAntigravityModelQuotaCooldowns(): { cleared: number } {
  const db = getDbInstance() as unknown as DbLike;
  const nowMs = Date.now();
  const nowStr = new Date(nowMs).toISOString();

  const rows = db
    .prepare(
      `SELECT id, is_active, test_status, rate_limited_until, error_code, last_error, last_error_type, last_error_source
       FROM provider_connections
       WHERE provider = \x27antigravity\x27`
    )
    .all() as Array<{
    id: string;
    is_active: number | boolean | null;
    test_status: string | null;
    rate_limited_until: string | number | null;
    error_code: string | number | null;
    last_error: string | null;
    last_error_type: string | null;
    last_error_source: string | null;
  }>;

  const toReset = rows.filter((row) => {
    const active = row.is_active === 1 || row.is_active === true;
    if (!active) return false;

    const status = (row.test_status || "").trim().toLowerCase();
    if (status !== "active" && status !== "") return false;

    if (row.rate_limited_until == null) return false;
    const rawLimit = String(row.rate_limited_until).trim();
    const time = /^\d+(\.\d+)?$/.test(rawLimit) ? Number(rawLimit) : new Date(rawLimit).getTime();
    if (!Number.isFinite(time) || time <= nowMs) return false;

    if (row.error_code !== null && String(row.error_code).trim() !== "") return false;
    if (row.last_error !== null && String(row.last_error).trim() !== "") return false;
    if (row.last_error_type !== null && String(row.last_error_type).trim() !== "") return false;
    if (row.last_error_source !== null && String(row.last_error_source).trim() !== "") return false;

    return true;
  });

  if (toReset.length === 0) return { cleared: 0 };

  const stmt = db.prepare(
    `UPDATE provider_connections SET
       rate_limited_until = NULL,
       backoff_level      = 0,
       updated_at         = ?
     WHERE id = ?`
  );

  for (const row of toReset) {
    stmt.run(nowStr, row.id);
  }

  invalidateDbCache("connections");

  return { cleared: toReset.length };
}

// ──────────────── T13: Stale Quota Display Fix ─────────────────────────────
// Codex/Claude quotas display stale cumulative usage after the window resets.
// By comparing resetAt timestamp to now(), we can show 0 when window has passed.
// Ref: sub2api PR #1171 (fix: quota display shows stale cumulative usage after reset)

/**
 * T13: Get effective quota usage, zeroing it out if the window has already reset.
 *
 * @param used - Stored usage value (tokens used in the window)
 * @param resetAt - ISO-8601 string or epoch ms when the window resets, or null
 * @returns Effective usage: 0 if window expired, original value otherwise
 */
export function getEffectiveQuotaUsage(
  used: number,
  resetAt: string | number | null | undefined
): number {
  if (!resetAt) return used;
  const resetTime = typeof resetAt === "number" ? resetAt : new Date(resetAt).getTime();
  if (isNaN(resetTime)) return used;
  // Window has passed — display should show 0 (pending next snapshot)
  if (Date.now() >= resetTime) return 0;
  return used;
}

/**
 * T05: Startup crash-recovery — clear stale transient connection cooldowns.
 *
 * After an unclean crash (SIGKILL, OOM-kill, large-body burst) the normal
 * error-handler paths that would clear/normalise cooldowns never run.
 * A connection's `rate_limited_until` may have been pushed far into the
 * future by exponential back-off.  On next startup that leaves all affected
 * connections excluded by `getProviderCredentials()`, so every request sits
 * in the Bottleneck queue and times out at `maxWaitMs` (120 s default).
 *
 * Safe invariants:
 *  - Only connections with `rate_limited_until IS NOT NULL` are touched.
 *  - Terminal states (`banned`, `expired`, `credits_exhausted`) are skipped —
 *    those require a deliberate credential change or operator reset.
 *  - Past timestamps are also cleared: they are already expired in the lazy
 *    expiry sense, but clearing them resets `backoffLevel` / transient error
 *    fields so the connection gets a clean slate on this fresh process.
 *
 * Must be called once, early in the startup sequence, before any request
 * is handled.  Returns the number of connections that were cleared.
 */
export function clearStaleCrashCooldowns(): { cleared: number } {
  const db = getDbInstance() as unknown as DbLike;
  const now = new Date().toISOString();

  const rows = db
    .prepare(
      `SELECT id, test_status, error_code, last_error_type, last_error_source
       FROM provider_connections
       WHERE rate_limited_until IS NOT NULL`
    )
    .all() as Array<{
    id: string;
    test_status: string | null;
    error_code: string | number | null;
    last_error_type: string | null;
    last_error_source: string | null;
  }>;

  const toReset = rows.filter((r) => !isTerminalOrAuthConnection(r));

  if (toReset.length === 0) return { cleared: 0 };

  const stmt = db.prepare(
    `UPDATE provider_connections SET
       rate_limited_until = NULL,
       test_status        = \x27active\x27,
       backoff_level      = 0,
       last_error         = NULL,
       last_error_at      = NULL,
       last_error_type    = NULL,
       last_error_source  = NULL,
       error_code         = NULL,
       updated_at         = ?
     WHERE id = ?`
  );

  for (const row of toReset) {
    stmt.run(now, row.id);
  }

  invalidateDbCache("connections");

  return { cleared: toReset.length };
}

// T13: Format a reset countdown as a human-readable string ("2h 35m" / "4m 30s").
// The implementation lives in the client-safe formatting utils so client
// components (e.g. CoolingConnectionsPanel) can import it without pulling this
// server-only DB module (better-sqlite3/ioredis) into the browser bundle.
// Re-exported here for existing server-side callers and the db/providers barrel.
export { formatResetCountdown } from "@/shared/utils/formatting";

function isTerminalOrAuthConnection(row: {
  test_status?: string | null;
  error_code?: string | number | null;
  last_error_type?: string | null;
  last_error_source?: string | null;
}): boolean {
  const status = (row.test_status || "").trim().toLowerCase();
  if (
    status === "banned" ||
    status === "expired" ||
    status === "credits_exhausted" ||
    status === "deactivated" ||
    status === "unrecoverable_refresh_error"
  ) {
    return true;
  }

  const code = row.error_code == null ? "" : String(row.error_code).trim().toLowerCase();
  if (code === "401" || code === "403") {
    return true;
  }

  const errType = (row.last_error_type || "").trim().toLowerCase();
  if (
    errType === "auth_error" ||
    errType === "unauthorized" ||
    errType === "forbidden" ||
    errType === "oauth_invalid_token" ||
    errType === "banned" ||
    errType === "deactivated" ||
    errType === "account_deactivated"
  ) {
    return true;
  }

  const errSource = (row.last_error_source || "").trim().toLowerCase();
  if (errSource && /oauth|auth|credential/i.test(errSource)) {
    return true;
  }

  return false;
}
