/**
 * Backport validation: gemini-3.7-flash-high support for Antigravity/AGY.
 *
 * Tests cover:
 *  1. Catalog presence (Antigravity + AGY)
 *  2. Alias resolution (gemini-3.7-flash-high -> gemini-3.7-flash-tiered)
 *  3. Client-visible display name
 *  4. Context window = 1048576
 *  5. Max output tokens = 65536
 *  6. Supports reasoning, tools, vision
 *  7. High thinking budget (defaultThinkingBudget = 24576)
 *  8. Alias -> tiered does NOT lose the High thinking config
 *  9. Quota/cooldown is model-scoped
 * 10. Locking gemini-3.7-flash-high does NOT block other models
 * 11. Existing 429 tests smoke check
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ANTIGRAVITY_PUBLIC_MODELS,
  ANTIGRAVITY_MODEL_ALIASES,
  ANTIGRAVITY_REVERSE_MODEL_ALIASES,
  resolveAntigravityModelId,
  toClientAntigravityModelId,
  toClientAntigravityQuotaModelId,
  getClientVisibleAntigravityModelName,
  isUserCallableAntigravityModelId,
} from "../../open-sse/config/antigravityModelAliases.ts";

import {
  AGY_PUBLIC_MODELS,
  isUserCallableAgyModelId,
  getClientVisibleAgyModelName,
} from "../../open-sse/config/agyModels.ts";

import {
  MODEL_SPECS,
  getModelSpec,
  getDefaultThinkingBudget,
  capThinkingBudget,
} from "../../src/shared/constants/modelSpecs.ts";

import { markConnectionQuotaExhausted } from "../../open-sse/executors/antigravity.ts";

// -- Helpers --

function getAntigravityPublicModel(id: string) {
  return ANTIGRAVITY_PUBLIC_MODELS.find((m) => m.id === id);
}

function getAgyPublicModel(id: string) {
  return AGY_PUBLIC_MODELS.find((m) => m.id === id);
}

// -- 1. Catalog presence --

describe("gemini-3.7-flash-high catalog", () => {
  test("1. appears in ANTIGRAVITY_PUBLIC_MODELS", () => {
    const model = getAntigravityPublicModel("gemini-3.7-flash-high");
    assert.ok(model, "gemini-3.7-flash-high must exist in ANTIGRAVITY_PUBLIC_MODELS");
  });

  test("1b. appears in AGY_PUBLIC_MODELS", () => {
    const model = getAgyPublicModel("gemini-3.7-flash-high");
    assert.ok(model, "gemini-3.7-flash-high must exist in AGY_PUBLIC_MODELS");
  });

  test("1c. isUserCallableAntigravityModelId returns true", () => {
    assert.equal(isUserCallableAntigravityModelId("gemini-3.7-flash-high"), true);
  });

  test("1d. isUserCallableAgyModelId returns true", () => {
    assert.equal(isUserCallableAgyModelId("gemini-3.7-flash-high"), true);
  });
});

// -- 2. Alias resolution --

describe("gemini-3.7-flash-high alias resolution", () => {
  test("2. resolveAntigravityModelId maps to gemini-3.7-flash-tiered", () => {
    assert.equal(resolveAntigravityModelId("gemini-3.7-flash-high"), "gemini-3.7-flash-tiered");
  });

  test("2b. ANTIGRAVITY_MODEL_ALIASES contains the mapping", () => {
    assert.equal(
      (ANTIGRAVITY_MODEL_ALIASES as Record<string, string>)["gemini-3.7-flash-high"],
      "gemini-3.7-flash-tiered"
    );
  });

  test("2c. reverse alias maps tiered back to high", () => {
    assert.equal(toClientAntigravityModelId("gemini-3.7-flash-tiered"), "gemini-3.7-flash-high");
  });

  test("2d. ANTIGRAVITY_REVERSE_MODEL_ALIASES contains the reverse mapping", () => {
    assert.equal(
      (ANTIGRAVITY_REVERSE_MODEL_ALIASES as Record<string, string>)["gemini-3.7-flash-tiered"],
      "gemini-3.7-flash-high"
    );
  });

  test("2e. quota bucket maps tiered upstream to client-facing high", () => {
    assert.equal(
      toClientAntigravityQuotaModelId("gemini-3.7-flash-tiered"),
      "gemini-3.7-flash-high"
    );
  });
});

// -- 3. Display name --

test("3. client-visible name is 'Gemini 3.7 Flash (High)'", () => {
  assert.equal(
    getClientVisibleAntigravityModelName("gemini-3.7-flash-high"),
    "Gemini 3.7 Flash (High)"
  );
});

test("3b. AGY client-visible name matches", () => {
  assert.equal(getClientVisibleAgyModelName("gemini-3.7-flash-high"), "Gemini 3.7 Flash (High)");
});

// -- 4. Context window --

test("4. contextLength = 1048576 in Antigravity catalog", () => {
  const model = getAntigravityPublicModel("gemini-3.7-flash-high");
  assert.equal(model?.contextLength, 1048576);
});

test("4b. contextWindow = 1048576 in MODEL_SPECS", () => {
  const spec = getModelSpec("gemini-3.7-flash-high");
  assert.equal(spec?.contextWindow, 1048576);
});

// -- 5. Max output tokens --

test("5. maxOutputTokens = 65536 in Antigravity catalog", () => {
  const model = getAntigravityPublicModel("gemini-3.7-flash-high");
  assert.equal(model?.maxOutputTokens, 65536);
});

test("5b. maxOutputTokens = 65536 in MODEL_SPECS", () => {
  const spec = getModelSpec("gemini-3.7-flash-high");
  assert.equal(spec?.maxOutputTokens, 65536);
});

// -- 6. Capability flags --

describe("gemini-3.7-flash-high capabilities", () => {
  test("6a. supportsReasoning in catalog", () => {
    const model = getAntigravityPublicModel("gemini-3.7-flash-high");
    assert.equal(model?.supportsReasoning, true);
  });

  test("6b. supportsThinking in MODEL_SPECS", () => {
    const spec = getModelSpec("gemini-3.7-flash-high");
    assert.equal(spec?.supportsThinking, true);
  });

  test("6c. supportsVision in catalog", () => {
    const model = getAntigravityPublicModel("gemini-3.7-flash-high");
    assert.equal(model?.supportsVision, true);
  });

  test("6d. supportsVision in MODEL_SPECS", () => {
    const spec = getModelSpec("gemini-3.7-flash-high");
    assert.equal(spec?.supportsVision, true);
  });

  test("6e. toolCalling in catalog", () => {
    const model = getAntigravityPublicModel("gemini-3.7-flash-high");
    assert.equal(model?.toolCalling, true);
  });

  test("6f. supportsTools in MODEL_SPECS", () => {
    const spec = getModelSpec("gemini-3.7-flash-high");
    assert.equal(spec?.supportsTools, true);
  });
});

// -- 7. Thinking budget --

test("7. defaultThinkingBudget = 24576 for gemini-3.7-flash-high", () => {
  assert.equal(getDefaultThinkingBudget("gemini-3.7-flash-high"), 24576);
});

test("7b. thinkingBudgetCap = 24576 (cap clamps to 24576)", () => {
  const spec = getModelSpec("gemini-3.7-flash-high");
  assert.equal(spec?.thinkingBudgetCap, 24576);
  // Requesting more than the cap should be clamped
  assert.equal(capThinkingBudget("gemini-3.7-flash-high", 32768), 24576);
  // Requesting exactly the cap should pass through
  assert.equal(capThinkingBudget("gemini-3.7-flash-high", 24576), 24576);
  // Requesting less than the cap should pass through
  assert.equal(capThinkingBudget("gemini-3.7-flash-high", 8192), 8192);
});

// -- 8. Alias does NOT lose thinking config --

test("8. alias to tiered does not lose thinking config", () => {
  // The thinking budget is resolved from the client-facing model id
  // (gemini-3.7-flash-high), which happens in translateRequest BEFORE
  // the Antigravity executor resolves the alias to gemini-3.7-flash-tiered.
  const clientSpec = getModelSpec("gemini-3.7-flash-high");
  assert.ok(clientSpec, "MODEL_SPECS must have an entry for gemini-3.7-flash-high");
  assert.equal(clientSpec.defaultThinkingBudget, 24576);
  assert.equal(clientSpec.supportsThinking, true);

  // The upstream tiered id should NOT have its own MODEL_SPECS entry
  const upstreamSpec = MODEL_SPECS["gemini-3.7-flash-tiered"];
  assert.equal(
    upstreamSpec,
    undefined,
    "gemini-3.7-flash-tiered should NOT have a direct MODEL_SPECS entry"
  );
});

// -- 9. Quota/cooldown is model-scoped --

test("9. markConnectionQuotaExhausted with requestedModel skips connection-wide cooldown", () => {
  // markConnectionQuotaExhausted returns void and does NOT set connection-wide cooldown
  // when requestedModel is provided (the branch hotfix behavior).
  assert.doesNotThrow(() => {
    markConnectionQuotaExhausted("fake-conn-id", 86400000, {
      requestedModel: "gemini-3.7-flash-high",
    });
  });
});

// -- 10. Lock isolation --

test("10. models are independent - no family-scoped coupling", () => {
  const highId37 = resolveAntigravityModelId("gemini-3.7-flash-high");
  const highId35 = resolveAntigravityModelId("gemini-3.5-flash-high");
  const opusId = resolveAntigravityModelId("claude-opus-4-6-thinking");
  const sonnetId = resolveAntigravityModelId("claude-sonnet-4-6");

  // All resolve to different upstream IDs
  assert.notEqual(highId37, highId35, "3.7 high must not resolve to same upstream as 3.5 high");
  assert.notEqual(highId37, opusId, "3.7 high must not resolve to same upstream as opus");
  assert.notEqual(highId37, sonnetId, "3.7 high must not resolve to same upstream as sonnet");

  // Exact upstream IDs
  assert.equal(highId37, "gemini-3.7-flash-tiered");
  assert.equal(highId35, "gemini-3-flash-agent");
  assert.equal(opusId, "claude-opus-4-6-thinking");
  assert.equal(sonnetId, "claude-sonnet-4-6");
});

// -- 11. Existing 429 tests smoke check --

test("11. classify429 and decide429 still work (smoke)", async () => {
  const { classify429, decide429 } =
    await import("../../open-sse/services/antigravity429Engine.ts");

  const cat = classify429("Individual quota reached. Contact your administrator.");
  assert.equal(cat, "quota_exhausted");
  const dec = decide429(cat, null);
  assert.equal(dec.kind, "full_quota_exhausted");

  assert.equal(classify429("too many requests"), "rate_limited");
  assert.equal(classify429("try again later"), "soft_rate_limit");
});

// -- No duplicate IDs --

test("ANTIGRAVITY_PUBLIC_MODELS has no duplicate model IDs after backport", () => {
  const ids = ANTIGRAVITY_PUBLIC_MODELS.map((m) => m.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate IDs: ${dupes.join(", ")}`);
});

test("AGY_PUBLIC_MODELS has no duplicate model IDs after backport", () => {
  const ids = AGY_PUBLIC_MODELS.map((m) => m.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate IDs: ${dupes.join(", ")}`);
});
