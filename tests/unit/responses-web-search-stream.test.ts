// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { closeCallLogArtifactWriter } from "../../src/lib/usage/callLogArtifactWriter.ts";

const { handleChatCore, isExplicitWebSearchToolChoice } =
  await import("../../open-sse/handlers/chatCore.ts");
const originalFetch = globalThis.fetch;

function sse(events: unknown[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

function parseSseFrames(body: string) {
  return body
    .trim()
    .split(/\r?\n\r?\n/)
    .map((frame) => {
      const fields = frame.split(/\r?\n/);
      const event = fields.find((line) => line.startsWith("event: "))?.slice("event: ".length);
      const data = fields.find((line) => line.startsWith("data: "))?.slice("data: ".length);
      return {
        event,
        data: data === "[DONE]" ? data : JSON.parse(data || "null"),
      };
    });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("1. stream=true web_search available tool_choice=auto => upstream receives stream=true", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), body });
    return new Response(
      sse([
        {
          id: "chatcmpl_test1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4o-mini",
          choices: [{ index: 0, delta: { role: "assistant", content: "hello" } }],
        },
        {
          id: "chatcmpl_test1",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4o-mini",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        },
      ]),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    );
  };

  const body = {
    model: "gpt-4o-mini",
    stream: true,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "search info" }],
      },
    ],
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
  };

  const result = await handleChatCore({
    body: structuredClone(body),
    modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
    credentials: { apiKey: "sk-test", providerSpecificData: {} },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clientRawRequest: {
      endpoint: "/v1/responses",
      body: structuredClone(body),
      headers: new Headers({ accept: "text/event-stream" }),
      userAgent: "codex-unit-test",
    },
  } as never);

  assert.equal(result.success, true);
  if (calls.length !== 1) throw new Error("calls: " + JSON.stringify(calls));
  assert.equal(calls[0].body.stream, true);
  const text = await result.response.text();
  assert.ok(text.includes("response.completed"));
});

test("2. stream=true web_search exec_command => upstream receives stream=true", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), body });
    return new Response(
      sse([
        {
          id: "chatcmpl_test2",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4o-mini",
          choices: [{ index: 0, delta: { role: "assistant", content: "running" } }],
        },
        {
          id: "chatcmpl_test2",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4o-mini",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        },
      ]),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    );
  };

  const body = {
    model: "gpt-4o-mini",
    stream: true,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "run command" }],
      },
    ],
    tools: [
      { type: "web_search" },
      {
        type: "function",
        name: "exec_command",
        description: "Executes a command",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
        },
      },
    ],
  };

  const result = await handleChatCore({
    body: structuredClone(body),
    modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
    credentials: { apiKey: "sk-test", providerSpecificData: {} },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clientRawRequest: {
      endpoint: "/v1/responses",
      body: structuredClone(body),
      headers: new Headers({ accept: "text/event-stream" }),
      userAgent: "codex-unit-test",
    },
  } as never);

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.stream, true);
  await result.response.text();
});

test("3. local function_call goes through canonical Responses SSE contains all required events", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), body });
    return new Response(
      sse([
        {
          id: "chatcmpl_fn",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_exec_1",
                    type: "function",
                    function: { name: "exec_command", arguments: '{"cmd":' },
                  },
                ],
              },
            },
          ],
        },
        {
          id: "chatcmpl_fn",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '"ls -la"}' },
                  },
                ],
              },
            },
          ],
        },
        {
          id: "chatcmpl_fn",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        },
      ]),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    );
  };

  const body = {
    model: "gpt-4o-mini",
    stream: true,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "list files" }],
      },
    ],
    tools: [
      { type: "web_search" },
      {
        type: "function",
        name: "exec_command",
        description: "Executes a command",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
        },
      },
    ],
  };

  const result = await handleChatCore({
    body: structuredClone(body),
    modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
    credentials: { apiKey: "sk-test", providerSpecificData: {} },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clientRawRequest: {
      endpoint: "/v1/responses",
      body: structuredClone(body),
      headers: new Headers({ accept: "text/event-stream" }),
      userAgent: "codex-unit-test",
    },
  } as never);

  assert.equal(result.success, true);
  assert.equal(calls[0].body.stream, true);

  const text = await result.response.text();
  const frames = parseSseFrames(text);
  const eventTypes = frames.map((f) => f.event).filter(Boolean);

  assert.ok(
    eventTypes.includes("response.output_item.added"),
    "missing response.output_item.added"
  );
  assert.ok(
    eventTypes.includes("response.function_call_arguments.delta"),
    "missing response.function_call_arguments.delta"
  );
  assert.ok(
    eventTypes.includes("response.function_call_arguments.done"),
    "missing response.function_call_arguments.done"
  );
  assert.ok(eventTypes.includes("response.output_item.done"), "missing response.output_item.done");
  assert.ok(eventTypes.includes("response.completed"), "missing response.completed");

  const added = frames.find((f) => f.event === "response.output_item.added");
  assert.equal(added?.data?.item?.type, "function_call");
  assert.equal(added?.data?.item?.name, "exec_command");

  const delta = frames.find((f) => f.event === "response.function_call_arguments.delta");
  assert.ok(typeof delta?.data?.delta === "string");

  const argDone = frames.find((f) => f.event === "response.function_call_arguments.done");
  assert.equal(argDone?.data?.arguments, '{"cmd":"ls -la"}');

  const itemDone = frames.find((f) => f.event === "response.output_item.done");
  assert.equal(itemDone?.data?.item?.type, "function_call");
  assert.equal(itemDone?.data?.item?.name, "exec_command");

  const completed = frames.find((f) => f.event === "response.completed");
  const outputCalls = completed?.data?.response?.output?.filter(
    (item: Record<string, unknown>) => item.type === "function_call"
  );
  assert.ok(outputCalls && outputCalls.length > 0);
  assert.equal(outputCalls[0].name, "exec_command");
});

test("4. stream=false remains stream=false", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), body });
    return new Response(
      JSON.stringify({
        id: "chatcmpl_nonstream",
        object: "chat.completion",
        created: 1,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "not streamed" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  };

  const body = {
    model: "gpt-4o-mini",
    stream: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ],
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
  };

  const result = await handleChatCore({
    body: structuredClone(body),
    modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
    credentials: { apiKey: "sk-test", providerSpecificData: {} },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clientRawRequest: {
      endpoint: "/v1/responses",
      body: structuredClone(body),
      headers: new Headers({ accept: "application/json" }),
      userAgent: "codex-unit-test",
    },
  } as never);

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.stream, false);
  const data = await result.response.json();
  assert.ok(data.output);
});

test("5. explicit web_search tool_choice supported, verify exact behavior preserve server-side fallback only", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const logEntries: Array<{ level: string; tag: string; msg: string }> = [];
  const captureLog = {
    debug() {},
    info(tag: string, msg: string) {
      logEntries.push({ level: "info", tag, msg });
    },
    warn() {},
    error() {},
  };

  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), body });
    return new Response(
      JSON.stringify({
        id: "chatcmpl_ws",
        object: "chat.completion",
        created: 1,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "search completed" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  };

  const body = {
    model: "gpt-4o-mini",
    stream: true,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "find news" }],
      },
    ],
    tools: [{ type: "web_search" }],
    tool_choice: { type: "web_search" },
  };

  const result = await handleChatCore({
    body: structuredClone(body),
    modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
    credentials: { apiKey: "sk-test", providerSpecificData: {} },
    log: captureLog,
    clientRawRequest: {
      endpoint: "/v1/responses",
      body: structuredClone(body),
      headers: new Headers({ accept: "text/event-stream" }),
      userAgent: "codex-unit-test",
    },
  } as never);

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.stream, false);
  assert.ok(
    logEntries.some(
      (e) =>
        e.tag === "TOOLS" &&
        e.msg.includes("web_search fallback forced non-streaming response for openai")
    ),
    "expected log entry for web_search fallback forced non-streaming"
  );
});

test("isExplicitWebSearchToolChoice accurately classifies tool_choice variants", () => {
  assert.equal(isExplicitWebSearchToolChoice(undefined), false);
  assert.equal(isExplicitWebSearchToolChoice(null), false);
  assert.equal(isExplicitWebSearchToolChoice("auto"), false);
  assert.equal(isExplicitWebSearchToolChoice("none"), false);
  assert.equal(isExplicitWebSearchToolChoice("required"), false);
  assert.equal(isExplicitWebSearchToolChoice({ type: "function", name: "exec_command" }), false);
  assert.equal(
    isExplicitWebSearchToolChoice({ type: "function", function: { name: "exec_command" } }),
    false
  );

  assert.equal(isExplicitWebSearchToolChoice("web_search"), true);
  assert.equal(isExplicitWebSearchToolChoice("web_search_preview"), true);
  assert.equal(isExplicitWebSearchToolChoice("web_search_20250305"), true);
  assert.equal(isExplicitWebSearchToolChoice({ type: "web_search" }), true);
  assert.equal(isExplicitWebSearchToolChoice({ type: "web_search_preview" }), true);
  assert.equal(isExplicitWebSearchToolChoice({ type: "web_search_20250305" }), true);
  assert.equal(isExplicitWebSearchToolChoice({ name: "web_search" }), true);
  assert.equal(isExplicitWebSearchToolChoice({ name: "web_search_preview" }), true);
  assert.equal(isExplicitWebSearchToolChoice({ name: "web_search_20250305" }), true);
  assert.equal(isExplicitWebSearchToolChoice({ name: "omniroute_web_search" }), true);
  assert.equal(
    isExplicitWebSearchToolChoice({ type: "function", name: "omniroute_web_search" }),
    true
  );
  assert.equal(
    isExplicitWebSearchToolChoice({ type: "function", function: { name: "omniroute_web_search" } }),
    true
  );
  assert.equal(isExplicitWebSearchToolChoice({ type: "function", name: "web_search" }), true);
});

test("ANTIGRAVITY: /v1/responses stream=true tools include web_search exec_command tool_choice absent/auto => upstream receives stream=true => canonical Responses SSE function_call events emitted", async () => {
  const calls: Array<{ url: string; stream: boolean }> = [];
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("antigravity-auto-updater")) {
      return new Response(JSON.stringify({ releases: [] }), { status: 200 });
    }
    calls.push({ url: urlStr, stream: urlStr.includes("streamGenerateContent") });
    const geminiChunk = {
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "exec_command",
                    args: { cmd: "echo hello" },
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 10,
          totalTokenCount: 20,
        },
      },
    };
    return new Response(`data: ${JSON.stringify(geminiChunk)}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const body = {
    model: "claude-opus-4-6-thinking",
    stream: true,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "run bash" }],
      },
    ],
    tools: [
      { type: "web_search" },
      {
        type: "function",
        name: "exec_command",
        description: "Run command",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
        },
      },
    ],
    tool_choice: "auto",
  };

  const result = await handleChatCore({
    body: structuredClone(body),
    modelInfo: {
      provider: "antigravity",
      model: "claude-opus-4-6-thinking",
      extendedContext: false,
    },
    credentials: { accessToken: "test-token", projectId: "test-project-123" },
    providerSpecificData: {},
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clientRawRequest: {
      endpoint: "/v1/responses",
      body: structuredClone(body),
      headers: new Headers({ accept: "text/event-stream" }),
      userAgent: "antigravity-regression-test",
    } as never,
  });

  assert.equal(result.success, true);
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(calls[0].stream, true, "upstream receives stream=true");
  assert.ok(calls[0].url.includes("streamGenerateContent?alt=sse"));

  const text = await result.response.text();
  const frames = parseSseFrames(text);
  const eventTypes = frames.map((f) => f.event).filter(Boolean);

  assert.ok(
    eventTypes.includes("response.output_item.added"),
    "missing response.output_item.added"
  );
  assert.ok(
    eventTypes.includes("response.function_call_arguments.delta"),
    "missing response.function_call_arguments.delta"
  );
  assert.ok(
    eventTypes.includes("response.function_call_arguments.done"),
    "missing response.function_call_arguments.done"
  );
  assert.ok(eventTypes.includes("response.output_item.done"), "missing response.output_item.done");
  assert.ok(eventTypes.includes("response.completed"), "missing response.completed");

  const added = frames.find((f) => f.event === "response.output_item.added");
  assert.equal(added?.data?.item?.type, "function_call");
  assert.equal(added?.data?.item?.name, "exec_command");

  const itemDone = frames.find((f) => f.event === "response.output_item.done");
  assert.equal(itemDone?.data?.item?.type, "function_call");
  assert.equal(itemDone?.data?.item?.name, "exec_command");
});

test("ANTIGRAVITY: explicit web_search_preview client stream=true executes server-side search and returns canonical Responses SSE ending with exactly one response.completed", async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const logEntries: Array<{ level: string; tag: string; msg: string }> = [];
  const captureLog = {
    debug() {},
    info(tag: string, msg: string) {
      logEntries.push({ level: "info", tag, msg });
    },
    warn() {},
    error() {},
  };
  globalThis.fetch = async (url, init = {}) => {
    const urlStr = String(url);
    if (urlStr.includes("antigravity-auto-updater")) {
      return new Response(JSON.stringify({ releases: [] }), { status: 200 });
    }
    if (urlStr.includes("duckduckgo.com")) {
      return new Response(
        `<!DOCTYPE html><html><body>
          <table>
            <tr><td><a class="result-link" href="https://example.com/antigravity-news">Antigravity Release Notes</a></td></tr>
            <tr><td class="result-snippet">Details on Antigravity LLM updates and features.</td></tr>
          </table>
        </body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    calls.push({ url: urlStr, body: init.body });
    const geminiChunk = {
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "omniroute_web_search",
                    args: { query: "Antigravity release notes" },
                  },
                },
              ],
            },
            finishReason: "STOP",
            usageMetadata: {
              promptTokenCount: 15,
              candidatesTokenCount: 12,
              totalTokenCount: 27,
            },
          },
        ],
      },
    };
    return new Response(`data: ${JSON.stringify(geminiChunk)}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const body = {
    model: "claude-opus-4-6-thinking",
    stream: true,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Search Antigravity release notes" }],
      },
    ],
    tools: [{ type: "web_search_preview", search_context_size: "low" }],
    tool_choice: { type: "web_search_preview" },
  };

  const result = await handleChatCore({
    body: structuredClone(body),
    modelInfo: {
      provider: "antigravity",
      model: "claude-opus-4-6-thinking",
      extendedContext: false,
    },
    credentials: {
      accessToken: "test-token",
      projectId: "test-project-123",
    },
    providerSpecificData: {},
    log: captureLog,
    clientRawRequest: {
      endpoint: "/v1/responses",
      body: structuredClone(body),
      headers: new Headers({ accept: "text/event-stream" }),
      userAgent: "antigravity-regression-test",
    },
  } as never);

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.ok(
    logEntries.some(
      (e) =>
        e.tag === "TOOLS" &&
        e.msg.includes("web_search fallback forced non-streaming response for antigravity")
    ),
    "expected log entry for web_search fallback forced non-streaming"
  );

  const contentType = result.response.headers.get("content-type") || "";
  assert.ok(contentType.includes("text/event-stream"), "expected text/event-stream content-type");

  const text = await result.response.text();

  assert.equal(
    text.includes('data: {"id":"resp_') || text.includes('data: {"object":"response"'),
    false,
    "must not emit raw completed JSON without event framing"
  );

  const completedMatches = text.match(/event:\s*response\.completed/g) || [];
  assert.equal(completedMatches.length, 1, "must contain exactly one event: response.completed");

  const frames = parseSseFrames(text);
  const eventTypes = frames.map((f) => f.event).filter(Boolean);

  assert.ok(eventTypes.includes("response.created"), "missing response.created");
  assert.ok(eventTypes.includes("response.in_progress"), "missing response.in_progress");
  assert.ok(
    eventTypes.includes("response.output_item.added"),
    "missing response.output_item.added"
  );
  assert.ok(eventTypes.includes("response.output_item.done"), "missing response.output_item.done");
  assert.ok(eventTypes.includes("response.completed"), "missing response.completed");

  const completedFrame = frames.find((f) => f.event === "response.completed");
  assert.ok(completedFrame?.data?.response?.output, "expected completed frame output");

  type OutputItem = {
    type: string;
    name?: string;
    status?: string;
    action?: { type?: string; query?: string; sources?: Array<{ title: string; url?: string }> };
    output?: unknown;
  };
  const output = completedFrame.data.response.output as OutputItem[];

  const functionCall = output.find((item) => item.type === "function_call");
  assert.ok(functionCall, "expected function_call output item");
  assert.equal(functionCall.name, "omniroute_web_search");

  const functionCallOutput = output.find((item) => item.type === "function_call_output");
  assert.ok(functionCallOutput, "expected function_call_output item");

  const webSearchCall = output.find((item) => item.type === "web_search_call");
  assert.ok(webSearchCall, "expected web_search_call item");
  assert.equal(webSearchCall.status, "completed");
  assert.equal(webSearchCall.action?.query, "Antigravity release notes");
  assert.ok(
    Array.isArray(webSearchCall.action?.sources) && webSearchCall.action.sources.length > 0
  );
  assert.equal(webSearchCall.action.sources[0].title, "Antigravity Release Notes");
});

test("ANTIGRAVITY: explicit web_search_preview client stream=false remains JSON (Content-Type: application/json, status completed, NO SSE framing)", async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const logEntries: Array<{ level: string; tag: string; msg: string }> = [];
  const captureLog = {
    debug() {},
    info(tag: string, msg: string) {
      logEntries.push({ level: "info", tag, msg });
    },
    warn() {},
    error() {},
  };

  globalThis.fetch = async (url, init = {}) => {
    const urlStr = String(url);
    if (urlStr.includes("antigravity-auto-updater")) {
      return new Response(JSON.stringify({ releases: [] }), { status: 200 });
    }
    if (urlStr.includes("duckduckgo.com")) {
      return new Response(
        `<!DOCTYPE html><html><body>
        <table>
          <tr><td><a class="result-link" href="https://example.com/antigravity-news">Antigravity Release Notes</a></td></tr>
          <tr><td class="result-snippet">Details on Antigravity LLM updates and features.</td></tr>
        </table>
        </body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    calls.push({ url: urlStr, body: init.body });
    const geminiChunk = {
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "omniroute_web_search",
                    args: { query: "Antigravity release notes" },
                  },
                },
              ],
            },
            finishReason: "STOP",
            usageMetadata: {
              promptTokenCount: 15,
              candidatesTokenCount: 12,
              totalTokenCount: 27,
            },
          },
        ],
      },
    };
    return new Response(`data: ${JSON.stringify(geminiChunk)}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const body = {
    model: "claude-opus-4-6-thinking",
    stream: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Search Antigravity release notes" }],
      },
    ],
    tools: [{ type: "web_search_preview", search_context_size: "low" }],
    tool_choice: { type: "web_search_preview" },
  };

  const result = await handleChatCore({
    body: structuredClone(body),
    modelInfo: {
      provider: "antigravity",
      model: "claude-opus-4-6-thinking",
      extendedContext: false,
    },
    credentials: {
      accessToken: "test-token",
      projectId: "test-project-123",
      providerSpecificData: {},
    },
    log: captureLog,
    clientRawRequest: {
      endpoint: "/v1/responses",
      body: structuredClone(body),
      headers: new Headers({ accept: "application/json" }),
      userAgent: "antigravity-regression-test",
    },
  } as never);

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  const contentType = result.response.headers.get("content-type") || "";
  assert.ok(contentType.includes("application/json"), "expected application/json content-type");
  assert.equal(contentType.includes("text/event-stream"), false, "must not be text/event-stream");

  const text = await result.response.text();
  assert.equal(text.includes("event:"), false, "must not contain SSE event framing");
  assert.equal(text.includes("data:"), false, "must not contain SSE data framing");

  const json = JSON.parse(text);
  assert.equal(json.status, "completed");
  assert.equal(json.object, "response");
  assert.ok(Array.isArray(json.output));
  assert.ok(json.output.some((item: { type: string }) => item.type === "web_search_call"));
});

test.after(async () => {
  await closeCallLogArtifactWriter(0);
});
