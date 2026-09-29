import test from "node:test";
import assert from "node:assert/strict";
import { fixToolPairs } from "../../open-sse/services/contextManager.ts";

test("fixToolPairs disambiguates duplicate tool call ids and matching results", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: "step 1" },
    {
      role: "assistant",
      tool_calls: [
        { id: "call_120666", type: "function", function: { name: "write_stdin", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_120666", content: "first" },
    { role: "user", content: "step 2" },
    {
      role: "assistant",
      tool_calls: [
        { id: "call_120666", type: "function", function: { name: "exec_command", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_120666", content: "second" },
  ];

  const fixed = fixToolPairs(messages);
  assert.equal((fixed[1].tool_calls as Array<{ id: string }>)[0].id, "call_120666");
  assert.equal(fixed[2].tool_call_id, "call_120666");
  assert.equal((fixed[4].tool_calls as Array<{ id: string }>)[0].id, "call_120666_2");
  assert.equal(fixed[5].tool_call_id, "call_120666_2");
  assert.deepEqual(fixToolPairs(fixed), fixed, "normalization must be idempotent");
});
