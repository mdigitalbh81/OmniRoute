import test from "node:test";
import assert from "node:assert/strict";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.ts";

test("preserves trailing Antigravity usageMetadata without candidates", () => {
  const state = {
    functionIndex: 0,
    messageId: "test-response",
    model: "antigravity/claude-opus-4-6-thinking",
    toolCalls: new Map(),
  };

  const result = geminiToOpenAIResponse(
    {
      response: {
        responseId: "test-response",
        modelVersion: "antigravity/claude-opus-4-6-thinking",
        usageMetadata: {
          promptTokenCount: 54232,
          candidatesTokenCount: 1200,
          thoughtsTokenCount: 350,
          totalTokenCount: 55782,
          cachedContentTokenCount: 32000,
        },
      },
    },
    state
  );

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);

  assert.deepEqual(result[0].choices, []);

  assert.deepEqual(result[0].usage, {
    prompt_tokens: 54232,
    completion_tokens: 1550,
    total_tokens: 55782,
    prompt_tokens_details: {
      cached_tokens: 32000,
    },
    completion_tokens_details: {
      reasoning_tokens: 350,
    },
  });
});
