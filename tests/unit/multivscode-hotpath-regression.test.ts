import assert from "node:assert/strict";
import { test } from "node:test";

import { isExplicitWebSearchToolChoice } from "../../open-sse/handlers/chatCore.ts";
import { fixToolPairs } from "../../open-sse/services/contextManager.ts";

test("web_search available/auto does not force non-stream fallback", () => {
  assert.equal(isExplicitWebSearchToolChoice(undefined), false);
  assert.equal(isExplicitWebSearchToolChoice("auto"), false);
  assert.equal(isExplicitWebSearchToolChoice({ type: "auto" }), false);
});

test("explicit web_search selection is detected", () => {
  assert.equal(isExplicitWebSearchToolChoice("web_search"), true);
  assert.equal(isExplicitWebSearchToolChoice("web_search_preview"), true);
  assert.equal(isExplicitWebSearchToolChoice({ type: "web_search_preview" }), true);
  assert.equal(
    isExplicitWebSearchToolChoice({ type: "function", function: { name: "omniroute_web_search" } }),
    true
  );
});

test("unique tool ids keep the normal path allocation-light", () => {
  const assistant = {
    role: "assistant",
    content: "ok",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "a", arguments: "{}" } }],
  };
  const tool = { role: "tool", tool_call_id: "call_1", content: "done" };
  const result = fixToolPairs([assistant, tool]);
  assert.equal(result.length, 2);
  assert.equal(result[0], assistant);
  assert.equal(result[1], tool);
  assert.equal((result[0].tool_calls as Array<{ id: string }>)[0].id, "call_1");
});

test("duplicate OpenAI tool ids are renamed FIFO with matching tool results", () => {
  const result = fixToolPairs([
    {
      role: "assistant",
      content: "one",
      tool_calls: [{ id: "call_dup", type: "function", function: { name: "a", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_dup", content: "r1" },
    {
      role: "assistant",
      content: "two",
      tool_calls: [{ id: "call_dup", type: "function", function: { name: "b", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_dup", content: "r2" },
  ]);

  const firstCall = ((result[0].tool_calls as Array<{ id: string }>)[0]).id;
  const secondCall = ((result[2].tool_calls as Array<{ id: string }>)[0]).id;
  assert.equal(firstCall, "call_dup");
  assert.equal(secondCall, "call_dup_2");
  assert.equal(result[1].tool_call_id, "call_dup");
  assert.equal(result[3].tool_call_id, "call_dup_2");
});

test("duplicate Claude tool_use ids are renamed with matching tool_result", () => {
  const result = fixToolPairs([
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tool_dup", name: "a", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool_dup", content: "r1" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tool_dup", name: "b", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool_dup", content: "r2" }],
    },
  ]);

  const firstUse = (result[0].content as Array<{ id: string }>)[0].id;
  const secondUse = (result[2].content as Array<{ id: string }>)[0].id;
  assert.equal(firstUse, "tool_dup");
  assert.equal(secondUse, "tool_dup_2");
  assert.equal((result[1].content as Array<{ tool_use_id: string }>)[0].tool_use_id, "tool_dup");
  assert.equal((result[3].content as Array<{ tool_use_id: string }>)[0].tool_use_id, "tool_dup_2");
});
