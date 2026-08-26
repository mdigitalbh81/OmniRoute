/**
 * Quota Cache — Domain Layer
 *
 * In-memory cache of provider quota data per connectionId.
 * Populated by:
 *   - Dashboard usage endpoint (GET /api/usage/[connectionId])
 *   - 429 responses marking account as exhausted
 *
 * Background refresh runs every 1 minute:
 *   - Active accounts (quota > 0%): refetch every 5 minutes
 *   - Exhausted accounts: refetch every 5 minutes (or immediately after resetAt passes)
 *
 * @module domain/quotaCache
 */

import { getUsageForProvider } from "@omniroute/open-sse/services/usage.ts";
import { getProviderConnectionById, resolveProxyForConnection } from "@/lib/localDb";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import { safePercentage } from "@/shared/utils/formatting";
import {
  saveQuotaSnapshot,
  cleanupOldSnapshots,
  getLatestQuotaSnapshotsForConnection,
} from "@/lib/db/quotaSnapshots";
import { recordProviderQuotaResetEventIfChanged } from "@/lib/db/quotaResetEvents";
import { getCodexQuotaWindowFilterForModel } from "@omniroute/open-sse/config/codexQuotaScopes.ts";
import { getQuotaScopedModelForProvider } from "@omniroute/open-sse/services/antigravityQuotaFamily.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

interface QuotaInfo {
  remainingPercentage: number;
  resetAt: string | null;
}

interface QuotaCacheEntry {
  connectionId: string;
  provider: string;
  quotas: Record<string, QuotaInfo>;
  fetchedAt: number;
  exhausted: boolean;
  nextResetAt: string | null;
  windowDurationMs?: number | null; // T08: optional rolling window duration
  exhaustedScopes?: Record<string, { fetchedAt: number; nextResetAt: string | null }>;
}

interface QuotaWindowStatus {
  remainingPercentage: number;
  usedPercentage: number;
  resetAt: string | null;
  reachedThreshold: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ACTIVE_TTL_MS = 5 * 60 * 1000; // 5 minutes for active accounts
const EXHAUSTED_TTL_MS = 5 * 60 * 1000; // 5 minutes for 429-sourced entries (no resetAt)
const EXHAUSTED_REFRESH_MS = 5 * 60 * 1000; // 5 minutes: recheck exhausted accounts (aligned with TTL)
const REFRESH_INTERVAL_MS = 60 * 1000; // Background tick every 1 minute
export const DEFAULT_QUOTA_THRESHOLD_PERCENT = 99;

// ─── State ──────────────────────────────────────────────────────────────────

const cache = new Map<string, QuotaCacheEntry>();
const MAX_CONCURRENT_REFRESHES = 5;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;

// ─── Helpers ────────────────────────────────────────────────────────────────

function isExhausted(quotas: Record<string, QuotaInfo>): boolean {
  const entries = Object.values(quotas);
  if (entries.length === 0) return false;
  return entries.every((q) => q.remainingPercentage <= 0);
}

/**
 * T08 — Auto-advance quota window.
 * If we know the window duration, advance past the expired window(s) to
 * avoid blocking requests when the quota reset already happened but the
 * background refresh hasn't run yet.
 */
function advancedWindowResetAt(entry: QuotaCacheEntry, now: number): { exhausted: false } | null {
  if (!entry.nextResetAt) return null;

  const resetMs = parseDate(entry.nextResetAt);
  if (resetMs === null) return null;

  // If the window's resetAt is in the past, the quota has been renewed.
  // Eagerly mark as available so requests don't wait for the 5-min TTL.
  if (resetMs <= now) {
    return { exhausted: false };
  }

  return null;
}

function parseDate(value: string): number | null {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function normalizeWindowKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isAntigravityProvider(provider: string | null | undefined): boolean {
  return provider === "antigravity" || provider === "agy";
}

function isReportedPositiveQuota(rawQuota: unknown, quota: QuotaInfo): boolean {
  if (!rawQuota || typeof rawQuota !== "object") return quota.remainingPercentage > 0;
  const raw = rawQuota as Record<string, unknown>;
  if (raw.fractionReported === false) return false;
  return quota.remainingPercentage > 0;
}

function getActiveScopedExhaustions(
  entry: QuotaCacheEntry,
  now = Date.now()
): Record<string, { fetchedAt: number; nextResetAt: string | null }> {
  const active: Record<string, { fetchedAt: number; nextResetAt: string | null }> = {};
  for (const [scope, state] of Object.entries(entry.exhaustedScopes || {})) {
    if (state.nextResetAt) {
      const resetMs = parseDate(state.nextResetAt);
      if (resetMs !== null && resetMs <= now) continue;
    } else if (now - state.fetchedAt > EXHAUSTED_TTL_MS) {
      continue;
    }
    active[scope] = state;
  }
  return active;
}

function hasActiveScopedExhaustion(
  entry: QuotaCacheEntry,
  provider: string,
  requestedModel: string | null
): boolean {
  if (!requestedModel) return false;
  const scope = getQuotaScopedModelForProvider(provider, requestedModel);
  if (!scope) return false;
  const activeScopes = getActiveScopedExhaustions(entry);
  if (Object.keys(activeScopes).length !== Object.keys(entry.exhaustedScopes || {}).length) {
    entry.exhaustedScopes = Object.keys(activeScopes).length > 0 ? activeScopes : undefined;
    entry.exhausted = isExhausted(entry.quotas) || Boolean(entry.exhaustedScopes);
  }
  return Boolean(activeScopes[scope]);
}

function mergePreservedScopedExhaustions(
  provider: string,
  rawQuotas: Record<string, any>,
  quotas: Record<string, QuotaInfo>,
  prior?: QuotaCacheEntry
): Record<string, { fetchedAt: number; nextResetAt: string | null }> | undefined {
  if (!isAntigravityProvider(provider) || !prior?.exhaustedScopes) return undefined;

  const activeScopes = getActiveScopedExhaustions(prior);
  for (const [windowKey, quota] of Object.entries(quotas)) {
    const rawQuota = rawQuotas[windowKey];
    if (!isReportedPositiveQuota(rawQuota, quota)) continue;
    const scope = getQuotaScopedModelForProvider(provider, windowKey);
    if (scope) delete activeScopes[scope];
  }

  return Object.keys(activeScopes).length > 0 ? activeScopes : undefined;
}

function getAntigravityScopedQuotaWindows(
  quotas: Record<string, QuotaInfo>,
  requestedModel: string | null
): string[] {
  if (!requestedModel) return [];

  const normalizedRequestedModel = normalizeWindowKey(
    requestedModel.replace(/^antigravity\//i, "")
  );
  if (!normalizedRequestedModel) return [];

  return Object.keys(quotas).filter((windowName) => {
    const normalizedWindow = normalizeWindowKey(windowName);
    return (
      normalizedWindow === normalizedRequestedModel ||
      normalizedWindow.endsWith(` ${normalizedRequestedModel}`)
    );
  });
}

function resolveQuotaWindow(
  quotas: Record<string, QuotaInfo>,
  windowName: string
): QuotaInfo | null {
  const direct = quotas[windowName];
  if (direct) return direct;

  const normalizedTarget = normalizeWindowKey(windowName);
  if (!normalizedTarget) return null;

  const prefixMatches: Array<{ key: string; quota: QuotaInfo }> = [];
  for (const [key, quota] of Object.entries(quotas)) {
    const normalizedKey = normalizeWindowKey(key);
    if (!normalizedKey) continue;
    if (normalizedKey === normalizedTarget) return quota;
    // Support canonical selection of generic windows from labeled windows,
    // e.g. "weekly" from "weekly (7d)" or "session" from "session (5h)".
    if (normalizedKey.startsWith(`${normalizedTarget} `)) {
      prefixMatches.push({ key, quota });
    }
  }

  // Deterministic fallback: choose the lexicographically first matching key.
  if (prefixMatches.length > 0) {
    prefixMatches.sort((a, b) => a.key.localeCompare(b.key));
    return prefixMatches[0].quota;
  }

  return null;
}

function earliestResetAt(quotas: Record<string, QuotaInfo>): string | null {
  let earliest: string | null = null;
  let earliestMs = Infinity;
  for (const q of Object.values(quotas)) {
    if (!q.resetAt) continue;
    const ms = parseDate(q.resetAt);
    if (ms !== null && ms < earliestMs) {
      earliestMs = ms;
      earliest = q.resetAt;
    }
  }
  return earliest;
}

/**
 * #4438 — Decide whether a quota snapshot row is worth persisting.
 *
 * The background refresh ticks every 60s for ALL connections, so idle accounts
 * (whose quota never changes) were generating 400K+ identical snapshot rows/day.
 * Returns true only when this window has no prior cached observation, or when its
 * `remaining_percentage` / `is_exhausted` differs from the last cached entry — so
 * the first observation and every real change persist, but idle no-op refreshes
 * stop writing. Pure (no I/O) for trivial unit testing.
 */
export function quotaSnapshotChanged(
  prior:
    | { quotas?: Record<string, { remainingPercentage: number }>; exhausted?: boolean }
    | null
    | undefined,
  windowKey: string,
  remainingPercentage: number,
  exhausted: boolean
): boolean {
  if (!prior) return true;
  const priorWindow = prior.quotas?.[windowKey];
  if (!priorWindow) return true;
  return (
    priorWindow.remainingPercentage !== remainingPercentage ||
    (prior.exhausted ?? false) !== exhausted
  );
}

function normalizeQuotas(rawQuotas: Record<string, any>): Record<string, QuotaInfo> {
  const result: Record<string, QuotaInfo> = {};
  for (const [key, q] of Object.entries(rawQuotas)) {
    if (q && typeof q === "object") {
      result[key] = {
        remainingPercentage:
          safePercentage(q.remainingPercentage) ??
          (q.total > 0 ? Math.round(((q.total - (q.used || 0)) / q.total) * 100) : 0),
        resetAt: q.resetAt || null,
      };
    }
  }
  return result;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function __clearForTests() {
  cache.clear();
}

export function isQuotaExhaustedForRequest(
  connectionId: string,
  provider: string,
  requestedModel: string | null = null
): boolean {
  const accountExhausted = isAccountQuotaExhausted(connectionId);
  const entry = cache.get(connectionId) || hydrateQuotaCacheFromSnapshots(connectionId);
  if (!entry) return false;

  if (isAntigravityProvider(provider) && requestedModel) {
    if (hasActiveScopedExhaustion(entry, provider, requestedModel)) return true;
    const scopedWindowNames = getAntigravityScopedQuotaWindows(entry.quotas, requestedModel);
    if (scopedWindowNames.length === 0) return false;
    return scopedWindowNames.some(
      (windowName) => getQuotaWindowStatus(connectionId, windowName, 100)?.reachedThreshold
    );
  }

  if (provider === "codex" && requestedModel) {
    const quotaNames = Object.keys(entry?.quotas || {});
    if (quotaNames.length === 0) return accountExhausted;
    const filterWindow = getCodexQuotaWindowFilterForModel(requestedModel);
    const scopedWindowNames = quotaNames.filter((windowName) => filterWindow?.(windowName));
    if (scopedWindowNames.length === 0) return accountExhausted;
    return scopedWindowNames.every(
      (windowName) => getQuotaWindowStatus(connectionId, windowName, 100)?.reachedThreshold
    );
  }

  if (!accountExhausted) return false;
  if (!requestedModel) return true;
  if (provider !== "codex") return true;
  const refreshedEntry = getQuotaCache(connectionId);
  const quotaNames = Object.keys(refreshedEntry?.quotas || {});
  if (quotaNames.length === 0) return true;
  const filterWindow = getCodexQuotaWindowFilterForModel(requestedModel);
  const scopedWindowNames = quotaNames.filter((windowName) => filterWindow?.(windowName));
  return (
    scopedWindowNames.length > 0 &&
    scopedWindowNames.every(
      (windowName) => getQuotaWindowStatus(connectionId, windowName, 100)?.reachedThreshold
    )
  );
}

/**
 * Store quota data for a connection (called by usage endpoint and background refresh).
 */
export function setQuotaCache(
  connectionId: string,
  provider: string,
  rawQuotas: Record<string, any>
) {
  const quotas = normalizeQuotas(rawQuotas);
  // #4438 — capture the prior entry BEFORE overwriting the cache so we can skip
  // redundant snapshot writes for idle connections whose quota didn't change.
  const prior = cache.get(connectionId);
  const exhaustedScopes = mergePreservedScopedExhaustions(provider, rawQuotas, quotas, prior);
  const exhausted = isExhausted(quotas) || Boolean(exhaustedScopes);
  const entry: QuotaCacheEntry = {
    connectionId,
    provider,
    quotas,
    fetchedAt: Date.now(),
    exhausted,
    nextResetAt: exhausted ? earliestResetAt(quotas) : null,
    exhaustedScopes,
  };
  cache.set(connectionId, entry);

  if (entry && rawQuotas) {
    for (const [windowKey, quotaInfo] of Object.entries(rawQuotas)) {
      if (!quotaInfo || typeof quotaInfo !== "object") continue;
      const remainingPercentage =
        safePercentage(quotaInfo.remainingPercentage) ??
        (quotaInfo.total > 0
          ? Math.round(((quotaInfo.total - (quotaInfo.used || 0)) / quotaInfo.total) * 100)
          : 0);
      recordProviderQuotaResetEventIfChanged({
        provider,
        connectionId,
        windowKey,
        currentResetAt: quotaInfo.resetAt ?? null,
        currentRemainingPercentage: remainingPercentage,
        previousObservation: prior?.quotas?.[windowKey]
          ? {
              resetAt: prior.quotas[windowKey].resetAt,
              remainingPercentage: prior.quotas[windowKey].remainingPercentage,
            }
          : null,
      });
      // #5923 (Finding #5) — is_exhausted must reflect THIS window's own remaining
      // percentage, not the connection-wide AND-across-all-windows aggregate
      // (`entry.exhausted`). A connection with one 0% window and other non-zero
      // windows previously never flagged that window's row as exhausted.
      const windowExhausted = remainingPercentage <= 0;
      // #4438 — only persist on the first observation or a real change.
      if (!quotaSnapshotChanged(prior, windowKey, remainingPercentage, windowExhausted)) continue;
      try {
        saveQuotaSnapshot({
          provider,
          connection_id: connectionId,
          window_key: windowKey,
          remaining_percentage: remainingPercentage,
          is_exhausted: windowExhausted ? 1 : 0,
          next_reset_at: quotaInfo.resetAt ?? null,
          window_duration_ms: entry.windowDurationMs ?? null,
          raw_data: null,
        });
      } catch (error) {
        console.error("[quotaCache] Failed to save snapshot:", error);
      }
    }
  }
}

/**
 * Get cached quota entry (returns null if not cached).
 */
export function getQuotaCache(connectionId: string): QuotaCacheEntry | null {
  return cache.get(connectionId) || null;
}

function hydrateQuotaCacheFromSnapshots(connectionId: string): QuotaCacheEntry | null {
  if (cache.has(connectionId)) return cache.get(connectionId) || null;

  let snapshots;
  try {
    snapshots = getLatestQuotaSnapshotsForConnection(connectionId);
  } catch {
    return null;
  }
  if (!snapshots.length) return null;

  const quotas: Record<string, QuotaInfo> = {};
  let provider = "";
  let fetchedAt = 0;
  let windowDurationMs: number | null = null;

  for (const snapshot of snapshots) {
    const camelSnapshot = snapshot as unknown as {
      windowKey?: string;
      remainingPercentage?: number | null;
      isExhausted?: number;
      nextResetAt?: string | null;
      windowDurationMs?: number | null;
      createdAt?: string;
    };
    const windowKey = camelSnapshot.windowKey ?? snapshot.window_key;
    if (!windowKey) continue;
    provider = provider || snapshot.provider || "";
    quotas[windowKey] = {
      remainingPercentage: clampPercent(
        Number(camelSnapshot.remainingPercentage ?? snapshot.remaining_percentage ?? 0)
      ),
      resetAt: camelSnapshot.nextResetAt ?? snapshot.next_reset_at ?? null,
    };
    const snapshotWindowDurationMs =
      camelSnapshot.windowDurationMs ?? snapshot.window_duration_ms ?? null;
    if (snapshotWindowDurationMs && snapshotWindowDurationMs > 0) {
      windowDurationMs = snapshotWindowDurationMs;
    }
    const createdAtVal = camelSnapshot.createdAt ?? snapshot.created_at;
    const createdAtMs = createdAtVal ? parseDate(createdAtVal) : null;
    if (createdAtMs !== null) fetchedAt = Math.max(fetchedAt, createdAtMs);
  }

  if (Object.keys(quotas).length === 0) return null;

  const exhausted = isExhausted(quotas);
  const entry: QuotaCacheEntry = {
    connectionId,
    provider,
    quotas,
    fetchedAt: fetchedAt || Date.now(),
    exhausted,
    nextResetAt: exhausted ? earliestResetAt(quotas) : null,
    windowDurationMs,
  };
  cache.set(connectionId, entry);
  return entry;
}

/**
 * Check if an account's quota is exhausted based on cached data.
 * Returns false if no cache entry exists (unknown = assume available).
 */
export function isAccountQuotaExhausted(connectionId: string): boolean {
  const entry = cache.get(connectionId) || hydrateQuotaCacheFromSnapshots(connectionId);
  if (!entry) return false;
  if (entry.exhaustedScopes) {
    const activeScopes = getActiveScopedExhaustions(entry);
    entry.exhaustedScopes = Object.keys(activeScopes).length > 0 ? activeScopes : undefined;
    entry.exhausted = isExhausted(entry.quotas) || Boolean(entry.exhaustedScopes);
  }
  if (!entry.exhausted) return false;

  const now = Date.now();

  // T08 — Auto window advance: if resetAt is in the past, eagerly treat as not exhausted.
  // This prevents stale exhaustion blocking when background refresh hasn't run yet.
  const advanced = advancedWindowResetAt(entry, now);
  if (advanced) {
    // Optimistically clear the exhausted flag so we unblock requests immediately.
    // The next background refresh will update with the real quota state.
    entry.exhausted = false;
    return false;
  }

  // Exhausted entries without resetAt expire after fixed TTL
  const age = now - entry.fetchedAt;
  if (!entry.nextResetAt && age > EXHAUSTED_TTL_MS) return false;

  return true;
}

/**
 * Return quota window status for a connection (e.g., session/weekly).
 * Returns null when no cache or no window data is available.
 */
export function getQuotaWindowStatus(
  connectionId: string,
  windowName: string,
  thresholdPercent = DEFAULT_QUOTA_THRESHOLD_PERCENT
): QuotaWindowStatus | null {
  const entry = cache.get(connectionId) || hydrateQuotaCacheFromSnapshots(connectionId);
  if (!entry) return null;

  const now = Date.now();

  const window = resolveQuotaWindow(entry.quotas, windowName);
  if (!window) return null;

  const remainingPercentage = clampPercent(window.remainingPercentage);
  const usedPercentage = clampPercent(100 - remainingPercentage);

  let resetAt = window.resetAt || null;
  let windowExpired = false;
  if (resetAt) {
    const resetMs = parseDate(resetAt);
    if (resetMs !== null && resetMs <= now) {
      resetAt = null;
      windowExpired = true;
    }
  }

  return {
    remainingPercentage,
    usedPercentage,
    resetAt,
    // If reset time has already passed, avoid stale cached percentages blocking selection.
    reachedThreshold: windowExpired ? false : usedPercentage >= thresholdPercent,
  };
}

/**
 * Mark an account as quota-exhausted from a 429 response (no quota data available).
 * Uses 5-minute fixed TTL since we don't know the actual resetAt.
 */
export function markAccountExhaustedFrom429(
  connectionId: string,
  provider: string,
  requestedModel: string | null = null
) {
  const scopedModel = requestedModel
    ? getQuotaScopedModelForProvider(provider, requestedModel)
    : null;
  if (isAntigravityProvider(provider) && scopedModel) {
    const prior = cache.get(connectionId) || hydrateQuotaCacheFromSnapshots(connectionId);
    const exhaustedScopes = {
      ...(prior?.exhaustedScopes || {}),
      [scopedModel]: { fetchedAt: Date.now(), nextResetAt: null },
    };
    cache.set(connectionId, {
      connectionId,
      provider,
      quotas: prior?.quotas || {},
      fetchedAt: Date.now(),
      exhausted: true,
      nextResetAt: prior?.nextResetAt || null,
      windowDurationMs: prior?.windowDurationMs ?? null,
      exhaustedScopes,
    });
    return;
  }

  cache.set(connectionId, {
    connectionId,
    provider,
    quotas: {},
    fetchedAt: Date.now(),
    exhausted: true,
    nextResetAt: null,
  });
}

// ─── Background Refresh ─────────────────────────────────────────────────────

const refreshingSet = new Set<string>();

async function refreshEntry(entry: QuotaCacheEntry) {
  if (refreshingSet.has(entry.connectionId)) return;
  refreshingSet.add(entry.connectionId);

  try {
    const connection = await getProviderConnectionById(entry.connectionId);
    if (!connection || connection.authType !== "oauth" || !connection.isActive) {
      cache.delete(entry.connectionId);
      return;
    }

    const proxyInfo = await resolveProxyForConnection(entry.connectionId);
    const usage = await runWithProxyContext(proxyInfo?.proxy || null, () =>
      getUsageForProvider(connection)
    );

    if (usage?.quotas) {
      setQuotaCache(entry.connectionId, entry.provider, usage.quotas);
    }
  } catch (err) {
    console.warn(
      `[QuotaCache] Refresh failed for ${entry.connectionId.slice(0, 8)}:`,
      (err as any)?.message || err
    );
  } finally {
    refreshingSet.delete(entry.connectionId);
  }
}

function needsRefresh(entry: QuotaCacheEntry, now: number): boolean {
  const age = now - entry.fetchedAt;
  if (entry.exhausted) {
    if (entry.nextResetAt) {
      const resetMs = parseDate(entry.nextResetAt);
      if (resetMs !== null && resetMs <= now) return true;
    }
    return age >= EXHAUSTED_REFRESH_MS;
  }
  return age >= ACTIVE_TTL_MS;
}

async function backgroundRefreshTick() {
  if (tickRunning) return;
  tickRunning = true;

  try {
    cleanupOldSnapshots();
    const now = Date.now();
    const pending = [...cache.values()].filter((e) => needsRefresh(e, now));

    // Refresh in batches to avoid thundering herd
    for (let i = 0; i < pending.length; i += MAX_CONCURRENT_REFRESHES) {
      const batch = pending.slice(i, i + MAX_CONCURRENT_REFRESHES);
      await Promise.allSettled(batch.map(refreshEntry));
    }
  } finally {
    tickRunning = false;
  }
}

/**
 * Start the background refresh timer.
 */
export function startBackgroundRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(backgroundRefreshTick, REFRESH_INTERVAL_MS);
  refreshTimer?.unref?.();
}

/**
 * Stop the background refresh timer.
 */
export function stopBackgroundRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Get cache stats (for debugging/dashboard).
 */
export function getQuotaCacheStats() {
  const entries: Array<{
    connectionId: string;
    provider: string;
    exhausted: boolean;
    nextResetAt: string | null;
    ageMs: number;
  }> = [];

  for (const entry of cache.values()) {
    entries.push({
      connectionId: entry.connectionId.slice(0, 8) + "...",
      provider: entry.provider,
      exhausted: entry.exhausted,
      nextResetAt: entry.nextResetAt,
      ageMs: Date.now() - entry.fetchedAt,
    });
  }

  return { total: cache.size, entries };
}
