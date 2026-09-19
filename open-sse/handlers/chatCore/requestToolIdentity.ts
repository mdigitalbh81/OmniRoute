export type NamespaceIdentity = { namespace: string; name: string };

/**
 * A tool identity entry is either a full namespace identity object (from
 * `_namespaceToolIdentityMap`) or a plain string alias (from `_toolNameMap`,
 * as produced on the Gemini/Antigravity path).
 */
export type ToolIdentityValue = NamespaceIdentity | string;

/**
 * Apply a resolved `ToolIdentityValue` to a function-call item mutably.
 * String aliases restore only `.name`; namespace identities restore both.
 * Returns true when any field changed.
 */
export function applyToolIdentity(
  item: { name?: string; namespace?: string },
  identity: ToolIdentityValue
): boolean {
  if (typeof identity === "string") {
    const changed = item.name !== identity;
    item.name = identity;
    return changed;
  }
  if (identity && typeof identity === "object" && typeof identity.name === "string") {
    const changed = item.namespace !== identity.namespace || item.name !== identity.name;
    item.namespace = identity.namespace;
    item.name = identity.name;
    return changed;
  }
  return false;
}

/**
 * Return a string-valued copy only when the complete map is an alias ledger.
 *
 * The legacy `_toolNameMap` side channel can carry either response aliases or
 * namespace identities. Checking every value before copying keeps those two
 * contracts separate and gives callers a real `Map<string, string>` instead of
 * asserting an identity map into the alias shape.
 */
export function toToolNameAliasMap(
  map: ReadonlyMap<string, unknown> | null
): Map<string, string> | null {
  if (!map || map.size === 0) return null;

  const aliases = new Map<string, string>();
  for (const [wireName, originalName] of map) {
    if (typeof originalName !== "string") return null;
    aliases.set(wireName, originalName);
  }
  return aliases;
}

/**
 * Decide which alias ledger the response translator gets.
 *
 * The ordering here is load-bearing. `extractRequestToolIdentityMap` runs
 * earlier in the request and DELETES `translatedBody._toolNameMap`, so by the
 * time the response map is resolved that property is already gone and
 * `translatedToolNameMap` is undefined for every Gemini/Antigravity request.
 * Without the `requestToolIdentityMap` fallback the ledger is silently dropped,
 * the response translator has nothing to reverse the sanitized wire name with
 * (`mcp__chrome-devtools__list_pages` goes out as
 * `mcp_chrome_devtools_list_pages`), and clients reject every MCP tool call
 * with "No such tool available" (#9568 / #7936).
 *
 * Only string-valued ledgers are recovered — `toToolNameAliasMap` returns null
 * for object-valued namespace identities so those are not reinterpreted as
 * response aliases.
 */
export function resolveResponseToolNameMap(
  translatedToolNameMap: unknown,
  nativeClaudeToolNameMap: Map<string, string> | null,
  requestToolIdentityMap: ReadonlyMap<string, unknown> | null
): Map<string, string> | null {
  if (translatedToolNameMap instanceof Map && translatedToolNameMap.size > 0) {
    return translatedToolNameMap as Map<string, string>;
  }
  return nativeClaudeToolNameMap ?? toToolNameAliasMap(requestToolIdentityMap);
}

/**
 * Extract the #7936 request-tool identity map from the translated body and
 * strip both side channels before dispatch.
 *
 * #9780 — prefer the dedicated `_namespaceToolIdentityMap`: on a pivot the
 * openai->claude/gemini step publishes its own alias `Map<string, string>` on
 * `_toolNameMap`, so that property alone can yield aliases instead of
 * identities. The `_toolNameMap` read stays as the fallback for the non-pivot
 * producers (executors/base.ts, cliproxyapi.ts, antigravity).
 */
export function extractRequestToolIdentityMap(
  translatedBody: Record<string, unknown>
): Map<string, ToolIdentityValue> | null {
  const namespaceIdentityMap = translatedBody._namespaceToolIdentityMap;
  const requestToolIdentityMap =
    namespaceIdentityMap instanceof Map
      ? namespaceIdentityMap
      : translatedBody._toolNameMap instanceof Map
        ? translatedBody._toolNameMap
        : null;
  delete translatedBody._namespaceToolIdentityMap;
  delete translatedBody._toolNameMap;
  return requestToolIdentityMap as Map<string, ToolIdentityValue> | null;
}
