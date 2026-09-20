/**
 * Client-safe provider-alias resolution.
 *
 * All data comes from the static maps in
 * src/shared/constants/providerAliases.ts so both browser and server
 * execute the same resolution for the same input.  No mutable state,
 * no configureProviderAliasResolver() call required.
 */
import { MANUAL_ALIAS_OVERRIDES, REGISTRY_ID_TO_ALIAS } from "../constants/providerAliases";

// Derive ALIAS_TO_PROVIDER_ID from REGISTRY_ID_TO_ALIAS (inverted)
// then apply manual overrides -- same logic as model.ts.
const ALIAS_TO_PROVIDER_ID: Record<string, string> = {};
for (const [id, alias] of Object.entries(REGISTRY_ID_TO_ALIAS)) {
  ALIAS_TO_PROVIDER_ID[alias] = id;
}
for (const [alias, id] of Object.entries(MANUAL_ALIAS_OVERRIDES)) {
  ALIAS_TO_PROVIDER_ID[alias] = id;
}

// Set of all known canonical provider IDs used for the transitive-chain
// boundary check ("stop as soon as a hop lands on a registered provider").
// Includes both: ids with non-identity aliases (keys of REGISTRY_ID_TO_ALIAS)
// and ids that are the target of any alias mapping.
const REGISTERED_PROVIDER_IDS = new Set<string>([
  ...Object.keys(REGISTRY_ID_TO_ALIAS),
  ...Object.values(ALIAS_TO_PROVIDER_ID),
]);

/**
 * Resolve provider alias to canonical provider ID.
 *
 * Follows alias chain transitively, STOPS as soon as a hop lands on a
 * registered provider id.  Guarded against infinite loops by both a
 * depth limit and a seen-set.  Semantics identical to the original
 * open-sse/services/model.ts implementation.
 */
export function resolveProviderAlias(aliasOrId: string | null | undefined): string | null {
  if (typeof aliasOrId !== "string") return null;
  let current = aliasOrId;
  const seen = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const next = ALIAS_TO_PROVIDER_ID[current];
    if (!next || next === current) return current;
    if (REGISTERED_PROVIDER_IDS.has(next)) return next;
    if (seen.has(next)) return next;
    seen.add(next);
    current = next;
  }
  return current;
}

// Backward compat: configureProviderAliasResolver is now a no-op.
// Kept so that open-sse/services/model.ts does not need changes
// beyond the scope of this fix.
/** @deprecated Maps are now static; this call is a no-op. */
export function configureProviderAliasResolver(
  _aliasMap: Record<string, string>,
  _idToAliasMap: Record<string, string>
): void {
  // intentional no-op -- data comes from providerAliases.ts
}
