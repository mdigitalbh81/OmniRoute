import test from "node:test";
import assert from "node:assert/strict";

import {
  ANTIGRAVITY_PUBLIC_MODELS,
  getClientVisibleAntigravityModelName,
  isDiscoverableAntigravityModelId,
  isUserCallableAntigravityModelId,
  resolveAntigravityModelId,
} from "../../open-sse/config/antigravityModelAliases.ts";

test("Gemini 3.8 Flash Tiered is discoverable and uses its exact upstream ID", () => {
  const id = "gemini-3.8-flash-tiered";
  const model = ANTIGRAVITY_PUBLIC_MODELS.find((entry) => entry.id === id);
  assert.ok(model);
  assert.equal(model.name, "Gemini 3.8 Flash (Tiered)");
  assert.equal(model.supportsReasoning, true);
  assert.equal(model.supportsVision, true);
  assert.equal(model.toolCalling, true);
  assert.equal(resolveAntigravityModelId(id), id);
  assert.equal(getClientVisibleAntigravityModelName(id), model.name);
  assert.equal(isDiscoverableAntigravityModelId(id), true);
  assert.equal(isUserCallableAntigravityModelId(id), true);
});
