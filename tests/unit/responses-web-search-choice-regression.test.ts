import test from "node:test";
import assert from "node:assert/strict";
import { isExplicitWebSearchToolChoice } from "../../open-sse/handlers/chatCore.ts";

test("web search tool choice is only explicit when the client selected it", () => {
  assert.equal(isExplicitWebSearchToolChoice(undefined), false);
  assert.equal(isExplicitWebSearchToolChoice("auto"), false);
  assert.equal(isExplicitWebSearchToolChoice("required"), false);
  assert.equal(isExplicitWebSearchToolChoice("web_search"), true);
  assert.equal(isExplicitWebSearchToolChoice("web_search_preview"), true);
  assert.equal(isExplicitWebSearchToolChoice({ type: "web_search_preview" }), true);
  assert.equal(isExplicitWebSearchToolChoice({ function: { name: "web_search" } }), true);
  assert.equal(isExplicitWebSearchToolChoice({ type: "function", function: { name: "exec_command" } }), false);
});
