import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import {
  isCompressionWorkerEligible,
  isStrictlySerializable,
} from "../../../open-sse/services/compression/compressionWorkerProtocol.ts";
import {
  closeCompressionWorkerPoolForTests,
  CompressionWorkerPool,
} from "../../../open-sse/services/compression/compressionWorkerPool.ts";
import {
  applyCompression,
  applyCompressionAsync,
} from "../../../open-sse/services/compression/strategySelector.ts";
import type { CompressionConfig } from "../../../open-sse/services/compression/types.ts";

const body = {
  model: "gpt-test",
  messages: [
    { role: "system", content: "Answer accurately." },
    {
      role: "user",
      content:
        "Please basically actually simply carefully help with this very important task. ".repeat(
          80
        ),
    },
  ],
};
const config = {
  enabled: true,
  defaultMode: "stacked",
  autoTriggerTokens: 1,
  cacheMinutes: 0,
  preserveSystemPrompt: true,
  stackedPipeline: [{ engine: "rtk" }, { engine: "caveman" }],
} as CompressionConfig;

function comparable<T extends { stats: { durationMs?: number; timestamp: number } | null }>(
  result: T
) {
  if (!result.stats) return result;
  const {
    durationMs: _duration,
    timestamp: _timestamp,
    engineBreakdown,
    ...stats
  } = result.stats as T["stats"] & {
    engineBreakdown?: Array<Record<string, unknown>>;
  };
  const stableBreakdown = engineBreakdown?.map(({ durationMs: _stepDuration, ...step }) => step);
  return {
    ...result,
    stats: {
      ...stats,
      ...(stableBreakdown ? { engineBreakdown: stableBreakdown } : {}),
    },
  };
}

after(() => closeCompressionWorkerPoolForTests());

describe("compression worker eligibility", () => {
  it("accepts standard, rtk, heuristic ultra, and approved rtk+caveman stacks", () => {
    assert.equal(isCompressionWorkerEligible(body, "standard", { config }), true);
    assert.equal(isCompressionWorkerEligible(body, "rtk", { config }), true);
    assert.equal(isCompressionWorkerEligible(body, "stacked", { config }), true);
    assert.equal(isCompressionWorkerEligible(body, "ultra", { config }), true);
    assert.equal(
      isCompressionWorkerEligible(body, "ultra", {
        config: { ...config, ultraEngine: "slm" } as CompressionConfig,
      }),
      false
    );
    assert.equal(
      isCompressionWorkerEligible(body, "ultra", {
        config: {
          ...config,
          ultra: { ...(config.ultra ?? {}), modelPath: "/tmp/model.onnx" },
        } as CompressionConfig,
      }),
      false
    );
    for (const mode of ["off", "lite", "aggressive", "omniglyph"] as const) {
      assert.equal(isCompressionWorkerEligible(body, mode, { config }), false);
    }
    for (const engine of ["llmlingua", "omniglyph", "ccr", "session-dedup", "ultra"]) {
      assert.equal(
        isCompressionWorkerEligible(body, "stacked", {
          config: { ...config, stackedPipeline: [{ engine }] } as CompressionConfig,
        }),
        false
      );
    }
  });

  it("rejects functions, symbols, classes, special objects, cycles, and non-finite numbers", () => {
    for (const value of [
      () => undefined,
      Symbol("x"),
      new Date(),
      new Map(),
      new Set(),
      /x/,
      NaN,
      Infinity,
    ]) {
      assert.equal(isStrictlySerializable(value), false);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(isStrictlySerializable(cyclic), false);
  });
});

describe("compression worker execution", () => {
  it("matches the synchronous body and stats except timing fields", async () => {
    const sync = applyCompression(body, "stacked", { config });
    const async = await applyCompressionAsync(body, "stacked", { config });
    assert.deepEqual(comparable(async), comparable(sync));
  });

  it("runs heuristic ultra in the worker and matches the synchronous result", async () => {
    const ultraConfig = {
      ...config,
      defaultMode: "ultra",
      ultraEngine: "heuristic",
      ultra: {
        ...(config.ultra ?? {}),
        compressionRate: 0.5,
        minScoreThreshold: 0.3,
        maxTokensPerMessage: 1,
      },
    } as CompressionConfig;
    const sync = applyCompression(body, "ultra", { config: ultraConfig });
    const async = await applyCompressionAsync(body, "ultra", { config: ultraConfig });
    assert.deepEqual(comparable(async), comparable(sync));
  });

  it("caps the private V8 heap of compression workers", async () => {
    const pool = new CompressionWorkerPool({
      size: 1,
      idleMs: 60_000,
      maxOldGenerationSizeMb: 256,
    });
    try {
      await pool.run(body, "standard", { config });
      const workers = (
        pool as unknown as {
          workers: Set<{ worker: Worker }>;
        }
      ).workers;
      const slot = [...workers][0];
      assert.ok(slot, "worker should remain pooled before idle eviction");
      assert.equal(slot.worker.resourceLimits.maxOldGenerationSizeMb, 256);
    } finally {
      await pool.close();
    }
  });

  it("preserves Responses bodies and hard-budget results", async () => {
    const responsesBody = {
      model: "gpt-test",
      input: [{ role: "user", content: [{ type: "input_text", text: "word ".repeat(600) }] }],
    };
    const hardBudgetConfig = { ...config, targetTokens: 100 };
    const sync = applyCompression(responsesBody, "stacked", { config: hardBudgetConfig });
    const async = await applyCompressionAsync(responsesBody, "stacked", {
      config: hardBudgetConfig,
    });
    assert.deepEqual(comparable(async), comparable(sync));
  });

  it("relays per-engine progress from the worker", async () => {
    const steps: string[] = [];
    await applyCompressionAsync(body, "stacked", {
      config,
      onEngineStep: (step) => steps.push(step.engine),
    });
    assert.deepEqual(steps, ["rtk", "caveman"]);
  });

  it("fails open without inline compression when a job times out", async () => {
    const pool = new CompressionWorkerPool({ size: 1, timeoutMs: 1, idleMs: 100 });
    try {
      const result = await pool.run(body, "stacked", { config });
      assert.deepEqual(result, { body, compressed: false, stats: null });
    } finally {
      await pool.close();
    }
  });

  it("terminates an idle worker instead of only dropping it from the pool", async () => {
    const spawned = new Set<Worker>();
    const terminated: Promise<number>[] = [];
    const originalPostMessage = Worker.prototype.postMessage;
    const originalTerminate = Worker.prototype.terminate;
    Worker.prototype.postMessage = function (this: Worker, ...args) {
      spawned.add(this);
      return originalPostMessage.apply(this, args);
    };
    Worker.prototype.terminate = function (this: Worker) {
      const exit = originalTerminate.call(this);
      terminated.push(exit);
      return exit;
    };
    const messagePorts = () =>
      process.getActiveResourcesInfo().filter((resource) => resource === "MessagePort").length;
    const portsBefore = messagePorts();
    const pool = new CompressionWorkerPool({ size: 1, idleMs: 50 });
    try {
      await pool.run(body, "stacked", { config });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(spawned.size, 1);
      assert.equal(terminated.length, 1, "idle eviction must terminate the worker thread");
      await Promise.all(terminated);
      assert.ok(messagePorts() <= portsBefore, "idle eviction must not retain the worker's port");
    } finally {
      Worker.prototype.postMessage = originalPostMessage;
      Worker.prototype.terminate = originalTerminate;
      await pool.close();
      // Reap anything the pool forgot so a regression fails instead of hanging the runner.
      await Promise.all([...spawned].map((worker) => worker.terminate().catch(() => undefined)));
    }
  });

  it("keeps the parent event loop responsive while two workers overlap", async () => {
    const largeBody = {
      messages: Array.from({ length: 400 }, (_, index) => ({
        role: "user",
        content: `message ${index} ` + "basically actually simply ".repeat(400),
      })),
    };
    let ticked = false;
    const tick = new Promise<void>((resolve) =>
      setTimeout(() => {
        ticked = true;
        resolve();
      }, 0)
    );
    const jobs = Promise.all([
      applyCompressionAsync(largeBody, "standard", { config }),
      applyCompressionAsync(largeBody, "standard", { config }),
    ]);
    await tick;
    assert.equal(ticked, true);
    await jobs;
  });
});
