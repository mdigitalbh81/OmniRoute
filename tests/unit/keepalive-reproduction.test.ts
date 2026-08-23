import test from "node:test";
import assert from "node:assert/strict";
import { handleComboChat } from "../../open-sse/services/combo.ts";
import { withEarlyStreamKeepalive } from "../../open-sse/utils/earlyStreamKeepalive.ts";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

async function drainStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += DECODER.decode(value, { stream: true });
  }
  return text;
}

test("CASO A: slow handler returns JSON error 429 after keepalive", async () => {
  const errorJson = { error: { message: "rate limited", type: "rate_limit" } };
  const slowFail = new Promise<Response>((resolve) => {
    setTimeout(
      () =>
        resolve(
          new Response(JSON.stringify(errorJson), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          })
        ),
      100
    );
  });

  const result = await withEarlyStreamKeepalive(slowFail, {
    thresholdMs: 20,
    intervalMs: 30,
  });

  assert.equal(result.status, 200, "Should commit to 200 SSE");

  const bodyText = await drainStream(result.body!);

  console.log("--- CASO A SSE PAYLOAD RECEIVED BY CLIENT ---");
  console.log(bodyText);
  console.log("---------------------------------------------");

  assert.ok(bodyText.includes(": omniroute-keepalive\n\n"), "Should have keepalive comments");
  assert.ok(bodyText.includes("event: error\n"), "Should emit in-band error event");
  assert.ok(bodyText.includes('"message":"rate limited"'), "Should contain error details");
  assert.ok(!bodyText.includes("response.completed"), "Should not contain response.completed");
  assert.ok(!bodyText.includes("response.failed"), "Should not contain response.failed");
});

test("CASO B: upstream stream throws error after partial content", async () => {
  let reads = 0;
  const upstreamStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      if (reads === 1) {
        controller.enqueue(
          ENCODER.encode(
            `data: {"type": "response.created", "response": {"id": "resp_123", "status": "in_progress"}}\n\n` +
              `data: {"type": "response.in_progress", "response": {"id": "resp_123", "status": "in_progress"}}\n\n`
          )
        );
        return;
      }
      if (reads === 2) {
        controller.error(new Error("upstream connection died mid-stream"));
      }
    },
  });

  const slowSseWithError = new Promise<Response>((resolve) => {
    setTimeout(() => {
      resolve(
        new Response(upstreamStream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );
    }, 100);
  });

  const result = await withEarlyStreamKeepalive(slowSseWithError, {
    thresholdMs: 20,
    intervalMs: 30,
  });

  assert.equal(result.status, 200, "Should commit to 200");

  let gotError = false;
  let bodyText = "";
  try {
    bodyText = await drainStream(result.body!);
  } catch {
    gotError = true;
  }

  console.log("--- CASO B SSE PAYLOAD RECEIVED BY CLIENT ---");
  console.log(bodyText);
  console.log(`Stream threw error (closed stream): ${gotError}`);
  console.log("---------------------------------------------");

  assert.ok(bodyText.includes("response.created"), "Should have response.created");
  assert.ok(bodyText.includes("response.in_progress"), "Should have response.in_progress");
  assert.ok(!bodyText.includes("response.completed"), "Should not contain response.completed");
  assert.ok(!bodyText.includes("response.failed"), "Should not contain response.failed");
});

test("CASO C: Target 1 fails 429, Target 2 succeeds SSE, keepalive preserves it", async () => {
  const target2Sse =
    `data: {"type": "response.created", "response": {"id": "resp_123", "status": "in_progress"}}\n\n` +
    `data: {"type": "response.completed", "response": {"id": "resp_123", "status": "completed"}}\n\n`;

  const slowComboSuccess = new Promise<Response>((resolve) => {
    setTimeout(() => {
      resolve(
        new Response(target2Sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );
    }, 100);
  });

  const result = await withEarlyStreamKeepalive(slowComboSuccess, {
    thresholdMs: 20,
    intervalMs: 30,
  });

  assert.equal(result.status, 200);

  const bodyText = await drainStream(result.body!);

  console.log("--- CASO C SSE PAYLOAD RECEIVED BY CLIENT ---");
  console.log(bodyText);
  console.log("---------------------------------------------");

  assert.ok(bodyText.includes(": omniroute-keepalive\n\n"), "Should have emitted keepalive");
  assert.ok(bodyText.includes("response.created"), "Should have response.created");
  assert.ok(
    bodyText.includes("response.completed"),
    "Should contain response.completed from Target 2"
  );
});

test("CASO C real combo loop: Target 1 fails 429, Target 2 returns completed SSE", async () => {
  const logEntries: Array<Record<string, unknown>> = [];
  const log = {
    info: (tag: string, msg: string, data?: unknown) =>
      logEntries.push({ level: "info", tag, msg, data }),
    warn: (tag: string, msg: string, data?: unknown) =>
      logEntries.push({ level: "warn", tag, msg, data }),
    error: (tag: string, msg: string, data?: unknown) =>
      logEntries.push({ level: "error", tag, msg, data }),
    debug: (tag: string, msg: string, data?: unknown) =>
      logEntries.push({ level: "debug", tag, msg, data }),
  };
  const target2Sse =
    `data: {"type": "response.created", "response": {"id": "resp_456", "status": "in_progress"}}\n\n` +
    `data: {"type": "response.completed", "response": {"id": "resp_456", "status": "completed"}}\n\n`;
  const attempted: string[] = [];
  const comboPromise = handleComboChat({
    body: { model: "combo/test", stream: true, input: "hello" },
    combo: {
      id: "combo-test",
      name: "combo-test",
      strategy: "priority",
      models: ["antigravity/failing", "antigravity/working"],
      config: { maxRetries: 0 },
    },
    handleSingleModel: async (_body, model) => {
      attempted.push(model);
      await new Promise((resolve) => setTimeout(resolve, model.includes("failing") ? 20 : 40));
      if (model.includes("failing")) {
        return new Response(JSON.stringify({ error: { message: "resource exhausted" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(target2Sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
    isModelAvailable: async () => true,
    log,
    settings: {},
    allCombos: [],
    signal: null,
  });

  const result = await withEarlyStreamKeepalive(comboPromise, {
    thresholdMs: 10,
    intervalMs: 30,
  });
  const bodyText = await drainStream(result.body!);

  console.log("--- CASO C REAL COMBO ATTEMPTS ---");
  console.log(JSON.stringify(attempted));
  console.log("--- CASO C REAL COMBO SSE PAYLOAD ---");
  console.log(bodyText);
  console.log("------------------------------------");

  assert.deepEqual(attempted, ["antigravity/failing", "antigravity/working"]);
  assert.ok(bodyText.includes(": omniroute-keepalive\n\n"));
  assert.ok(bodyText.includes("response.completed"));
});
