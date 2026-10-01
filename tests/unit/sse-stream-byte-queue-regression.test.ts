import test from "node:test";
import assert from "node:assert/strict";
import { createByteLengthQueueStrategy } from "../../open-sse/utils/stream.ts";

test("SSE queue strategy measures Uint8Array capacity in bytes", () => {
  const strategy = createByteLengthQueueStrategy(16384);
  assert.equal(strategy.highWaterMark, 16384);
  assert.equal(strategy.size?.(new Uint8Array(1)), 1);
  assert.equal(strategy.size?.(new Uint8Array(4096)), 4096);
  assert.equal(strategy.size?.(new Uint8Array(16384)), 16384);
});
