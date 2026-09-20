/**
 * Drift gate: ensures src/shared/constants/providerAliases.ts stays in
 * sync with the authoritative source (providerRegistry + MANUAL_ALIAS_OVERRIDES).  Fails when a provider is added/removed/alias-changed in
 * the registry without updating the shared constant.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateAliasMap } from "../../open-sse/config/providerRegistry.ts";
import {
  MANUAL_ALIAS_OVERRIDES,
  REGISTRY_ID_TO_ALIAS,
} from "../../src/shared/constants/providerAliases.ts";
import { resolveProviderAlias } from "../../src/shared/utils/providerAlias.ts";

describe("provider-alias drift gate", () => {
  it("REGISTRY_ID_TO_ALIAS matches generateAliasMap() non-identity entries", () => {
    const authoritative = generateAliasMap();
    const expected: Record<string, string> = {};
    for (const [id, alias] of Object.entries(authoritative)) {
      if (id !== alias) expected[id] = alias;
    }
    assert.deepStrictEqual(
      REGISTRY_ID_TO_ALIAS,
      expected,
      "src/shared/constants/providerAliases.ts REGISTRY_ID_TO_ALIAS is out " +
        "of sync with providerRegistry.  Regenerate it from the registry " +
        "(see the comment at the top of that file)."
    );
  });

  it("MANUAL_ALIAS_OVERRIDES snapshot matches expected overrides", () => {
    // These are the manual overrides hardcoded in open-sse/services/model.ts.
    // If an override is added/removed/changed, update both
    // providerAliases.ts and this expected snapshot.
    const expected: Record<string, string> = {
      opencode: "opencode-zen",
      xiaomi: "xiaomi-mimo",
      llamacpp: "llama-cpp",
      agy: "antigravity",
      aq: "amazon-q",
    };
    assert.deepStrictEqual(MANUAL_ALIAS_OVERRIDES, expected);
  });

  it("client-safe resolveProviderAlias matches server-side for ALL inputs", () => {
    const idToAlias = generateAliasMap();
    // Build server-side ALIAS_TO_PROVIDER_ID exactly as model.ts does
    // (registry inversion + MANUAL_ALIAS_OVERRIDES)
    const aliasToProvider: Record<string, string> = {};
    for (const [id, alias] of Object.entries(idToAlias)) {
      aliasToProvider[alias] = id;
    }
    for (const [alias, id] of Object.entries(MANUAL_ALIAS_OVERRIDES)) {
      aliasToProvider[alias] = id;
    }

    function serverResolve(aliasOrId: string): string {
      let current = aliasOrId;
      const seen = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const next = aliasToProvider[current];
        if (!next || next === current) return current;
        if (next in idToAlias) return next;
        if (seen.has(next)) return next;
        seen.add(next);
        current = next;
      }
      return current;
    }

    const allInputs = new Set([...Object.keys(aliasToProvider), ...Object.keys(idToAlias)]);

    const divergences: string[] = [];
    for (const input of allInputs) {
      const server = serverResolve(input);
      const client = resolveProviderAlias(input);
      if (server !== client) {
        divergences.push(`${input}: server=${server} client=${client}`);
      }
    }
    assert.equal(
      divergences.length,
      0,
      `Client-safe resolveProviderAlias diverges from server for:\n${divergences.join("\n")}`
    );
  });
});
