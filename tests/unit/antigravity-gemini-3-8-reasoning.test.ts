import test from "node:test";
import assert from "node:assert/strict";

import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";

const MODEL = "gemini-3.8-flash-tiered";

function request(effort: "low" | "high") {
  return openaiToAntigravityRequest(
    MODEL,
    {
      model: `antigravity/${MODEL}`,
      messages: [{ role: "user", content: "Reply OK." }],
      reasoning_effort: effort,
    },
    true
  ) as {
    model: string;
    request: {
      contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
      generationConfig: {
        thinkingConfig?: { thinkingBudget?: number; includeThoughts?: boolean };
      };
    };
  };
}

test("Gemini 3.8 Tiered: High effort is translated into Cloud Code thinkingConfig", () => {
  const low = request("low");
  const high = request("high");

  assert.equal(high.model, MODEL);
  assert.equal(low.model, MODEL);
  assert.ok(high.request.generationConfig.thinkingConfig);
  assert.ok(low.request.generationConfig.thinkingConfig);

  const highBudget = high.request.generationConfig.thinkingConfig?.thinkingBudget;
  const lowBudget = low.request.generationConfig.thinkingConfig?.thinkingBudget;
  assert.equal(typeof highBudget, "number");
  assert.equal(typeof lowBudget, "number");
  assert.ok((highBudget ?? 0) > (lowBudget ?? 0), "High must be greater than Low");
  assert.equal(high.request.generationConfig.thinkingConfig?.includeThoughts, true);

  assert.ok(high.request.contents.some((turn) => turn.role === "user"));
});

test("Gemini 3.8 Tiered: no speculative high model alias is emitted", () => {
  const high = request("high");
  assert.equal(high.model, "gemini-3.8-flash-tiered");
  assert.notEqual(high.model, "gemini-3.8-flash-high");
});
