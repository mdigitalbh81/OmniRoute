import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveProviderAlias } from "../../src/shared/utils/providerAlias.ts";

describe("src/shared/utils/providerAlias (client-safe, static data)", () => {
  it("returns null for non-string input", () => {
    assert.equal(resolveProviderAlias(null), null);
    assert.equal(resolveProviderAlias(undefined), null);
    assert.equal(resolveProviderAlias(42 as unknown as string), null);
  });

  it("resolves known registry aliases", () => {
    assert.equal(resolveProviderAlias("gh"), "github");
    assert.equal(resolveProviderAlias("ds"), "deepseek");
    assert.equal(resolveProviderAlias("cc"), "claude");
    assert.equal(resolveProviderAlias("oc"), "opencode");
  });

  it("resolves manual alias overrides", () => {
    assert.equal(resolveProviderAlias("aq"), "amazon-q");
    assert.equal(resolveProviderAlias("agy"), "antigravity");
    assert.equal(resolveProviderAlias("llamacpp"), "llama-cpp");
    assert.equal(resolveProviderAlias("xiaomi"), "xiaomi-mimo");
  });

  it("resolves opencode -> opencode-zen (manual override)", () => {
    assert.equal(resolveProviderAlias("opencode"), "opencode-zen");
  });

  it("stops at registered provider (transitive boundary)", () => {
    // "opencode" is a manual override -> "opencode-zen".
    // "opencode-zen" is a registered provider with alias "oc" in registry,
    // so it IS in REGISTERED_PROVIDER_IDS and the chain stops there.
    assert.equal(resolveProviderAlias("opencode"), "opencode-zen");
  });

  it("returns identity for canonical provider IDs", () => {
    assert.equal(resolveProviderAlias("openai"), "openai");
    assert.equal(resolveProviderAlias("anthropic"), "anthropic");
    assert.equal(resolveProviderAlias("amazon-q"), "amazon-q");
    assert.equal(resolveProviderAlias("antigravity"), "antigravity");
  });

  it("returns identity for unknown strings", () => {
    assert.equal(resolveProviderAlias("unknown-thing"), "unknown-thing");
    assert.equal(resolveProviderAlias("not-a-provider"), "not-a-provider");
  });
});
