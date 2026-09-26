/**
 * Static Claude Code default model IDs for client-safe consumption.
 *
 * These values mirror the first fable/opus/sonnet/haiku entries in the
 * Claude provider registry (open-sse/config/providers/registry/claude/).
 * A drift-gate test (tests/unit/claude-code-models-drift.test.ts) ensures
 * this file stays in sync with getClaudeCodeDefaultModels().
 */
export const CLAUDE_CODE_DEFAULTS = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
} as const;
