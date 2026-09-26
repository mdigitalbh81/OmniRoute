/**
 * Drift gate: ensures src/shared/constants/claudeCodeModels.ts stays in
 * sync with the authoritative getClaudeCodeDefaultModels() from the
 * provider registry.  Fails when a Claude model is updated in the
 * registry without updating the shared constant.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getClaudeCodeDefaultModels } from "../../open-sse/config/providerRegistry.ts";
import { CLAUDE_CODE_DEFAULTS } from "../../src/shared/constants/claudeCodeModels.ts";

describe("claude-code-models drift gate", () => {
  it("CLAUDE_CODE_DEFAULTS matches getClaudeCodeDefaultModels()", () => {
    const authoritative = getClaudeCodeDefaultModels();
    assert.deepStrictEqual(
      { ...CLAUDE_CODE_DEFAULTS },
      authoritative,
      "src/shared/constants/claudeCodeModels.ts is out of sync with " +
        "the Claude provider registry. Update CLAUDE_CODE_DEFAULTS to match " +
        "getClaudeCodeDefaultModels()."
    );
  });
});
