// @ts-nocheck
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { closeCallLogArtifactWriter } from "../../src/lib/usage/callLogArtifactWriter.ts";

import {
  applyToolIdentity,
  extractRequestToolIdentityMap,
  type ToolIdentityValue,
} from "../../open-sse/handlers/chatCore/requestToolIdentity.ts";
import { restoreResponsesPassthroughFunctionCallIdentity } from "../../open-sse/utils/stream.ts";
import { handleChatCore } from "../../open-sse/handlers/chatCore.ts";

// ---------------------------------------------------------------------------
// 1. applyToolIdentity unit tests
// ---------------------------------------------------------------------------

describe("applyToolIdentity", () => {
  it("restores name from string alias (Gemini/Antigravity _toolNameMap)", () => {
    const item = { name: "omniroute_web_search", type: "function_call" };
    const changed = applyToolIdentity(item, "omniroute_web_search");
    assert.equal(item.name, "omniroute_web_search");
    // same value → no change
    assert.equal(changed, false);
  });

  it("restores name from string alias when sanitized name differs", () => {
    const item = { name: "sanitized_name", type: "function_call" };
    const changed = applyToolIdentity(item, "original.tool-name");
    assert.equal(item.name, "original.tool-name");
    assert.equal(changed, true);
  });

  it("restores namespace + name from NamespaceIdentity object", () => {
    const item: { name?: string; namespace?: string } = {
      name: "mcp__files__read",
    };
    const identity = { namespace: "mcp__files", name: "read" };
    const changed = applyToolIdentity(item, identity);
    assert.equal(item.name, "read");
    assert.equal(item.namespace, "mcp__files");
    assert.equal(changed, true);
  });

  it("returns false for NamespaceIdentity when already correct", () => {
    const item = { name: "read", namespace: "mcp__files" };
    const identity = { namespace: "mcp__files", name: "read" };
    const changed = applyToolIdentity(item, identity);
    assert.equal(changed, false);
  });

  it("does not set namespace when identity is a string", () => {
    const item: { name?: string; namespace?: string } = {
      name: "old_name",
    };
    applyToolIdentity(item, "new_name");
    assert.equal(item.name, "new_name");
    assert.equal(item.namespace, undefined);
  });
});

// ---------------------------------------------------------------------------
// 2. extractRequestToolIdentityMap returns union-typed map
// ---------------------------------------------------------------------------

describe("extractRequestToolIdentityMap", () => {
  it("extracts string-valued _toolNameMap as ToolIdentityValue map", () => {
    const body: Record<string, unknown> = {
      _toolNameMap: new Map<string, string>([["omniroute_web_search", "omniroute_web_search"]]),
    };
    const map = extractRequestToolIdentityMap(body);
    assert.ok(map);
    const value = map.get("omniroute_web_search");
    assert.equal(typeof value, "string");
    assert.equal(value, "omniroute_web_search");
    // side channel cleaned
    assert.equal(body._toolNameMap, undefined);
  });

  it("prefers _namespaceToolIdentityMap over _toolNameMap", () => {
    const nsMap = new Map([["mcp__files__read", { namespace: "mcp__files", name: "read" }]]);
    const body: Record<string, unknown> = {
      _namespaceToolIdentityMap: nsMap,
      _toolNameMap: new Map([["mcp__files__read", "mcp__files__read"]]),
    };
    const map = extractRequestToolIdentityMap(body);
    assert.ok(map);
    const value = map.get("mcp__files__read")!;
    assert.equal(typeof value, "object");
    assert.deepEqual(value, { namespace: "mcp__files", name: "read" });
    // both side channels cleaned
    assert.equal(body._namespaceToolIdentityMap, undefined);
    assert.equal(body._toolNameMap, undefined);
  });
});

// ---------------------------------------------------------------------------
// 3. Simulated non-stream Responses identity restoration
// ---------------------------------------------------------------------------

describe("non-stream identity restoration simulation", () => {
  function restoreOutputIdentities(
    output: Array<{ type: string; name: string; namespace?: string }>,
    identityMap: Map<string, ToolIdentityValue>
  ) {
    for (const item of output) {
      if (item.type !== "function_call") continue;
      const identity = identityMap.get(item.name);
      if (identity) applyToolIdentity(item, identity);
    }
  }

  it("preserves omniroute_web_search name from string alias map", () => {
    const output = [{ type: "function_call", name: "omniroute_web_search" }];
    const map = new Map<string, ToolIdentityValue>([
      ["omniroute_web_search", "omniroute_web_search"],
    ]);
    restoreOutputIdentities(output, map);
    assert.equal(output[0].name, "omniroute_web_search");
    assert.equal(output[0].namespace, undefined);
  });

  it("restores namespace identity from object map", () => {
    const output = [{ type: "function_call", name: "mcp__atlassian__read_issue" }];
    const map = new Map<string, ToolIdentityValue>([
      ["mcp__atlassian__read_issue", { namespace: "mcp__atlassian", name: "read_issue" }],
    ]);
    restoreOutputIdentities(output, map);
    assert.equal(output[0].name, "read_issue");
    assert.equal(output[0].namespace, "mcp__atlassian");
  });

  it("Antigravity web_search_preview function_call retains name for skills", () => {
    // Simulates: Antigravity returns function_call with name omniroute_web_search
    // _toolNameMap carries string alias "omniroute_web_search" → "omniroute_web_search"
    // After identity restoration, name must stay "omniroute_web_search"
    // so skills interceptor can resolve BUILTIN_TOOL_ALIASES → "web_search"
    const output = [
      {
        type: "function_call",
        name: "omniroute_web_search",
        arguments: JSON.stringify({ query: "latest news" }),
      },
    ];
    const map = new Map<string, ToolIdentityValue>([
      ["omniroute_web_search", "omniroute_web_search"],
    ]);
    restoreOutputIdentities(output, map);
    assert.equal(output[0].name, "omniroute_web_search");

    // Verify skills interceptor alias resolution would match
    const BUILTIN_TOOL_ALIASES: Record<string, string> = {
      omniroute_web_search: "web_search",
    };
    const resolved = BUILTIN_TOOL_ALIASES[output[0].name] ?? output[0].name;
    assert.equal(resolved, "web_search");
  });
});

// ---------------------------------------------------------------------------
// 4. Streaming function-call identity restoration (stream.ts)
// ---------------------------------------------------------------------------

describe("restoreResponsesPassthroughFunctionCallIdentity", () => {
  it("restores string alias on response.output_item.added", () => {
    const event = {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "sanitized_tool_name",
        call_id: "call_1",
      },
    };
    const map = new Map<string, ToolIdentityValue>([["sanitized_tool_name", "original.tool-name"]]);
    const changed = restoreResponsesPassthroughFunctionCallIdentity(event, map);
    assert.equal(changed, true);
    assert.equal(event.item.name, "original.tool-name");
    assert.equal((event.item as { namespace?: string }).namespace, undefined);
  });

  it("restores string alias on response.output_item.done", () => {
    const event = {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "omniroute_web_search",
        call_id: "call_2",
      },
    };
    const map = new Map<string, ToolIdentityValue>([
      ["omniroute_web_search", "omniroute_web_search"],
    ]);
    // Same value → returns false
    const changed = restoreResponsesPassthroughFunctionCallIdentity(event, map);
    assert.equal(changed, false);
    assert.equal(event.item.name, "omniroute_web_search");
  });

  it("restores NamespaceIdentity on response.output_item.added", () => {
    const event = {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "mcp__files__read",
        call_id: "call_3",
      },
    };
    const map = new Map<string, ToolIdentityValue>([
      ["mcp__files__read", { namespace: "mcp__files", name: "read" }],
    ]);
    const changed = restoreResponsesPassthroughFunctionCallIdentity(event, map);
    assert.equal(changed, true);
    assert.equal(event.item.name, "read");
    assert.equal((event.item as { namespace?: string }).namespace, "mcp__files");
  });

  it("restores identities on response.completed output array", () => {
    const event = {
      type: "response.completed",
      response: {
        output: [
          {
            type: "function_call",
            name: "sanitized_exec",
            call_id: "call_exec",
          },
          {
            type: "function_call",
            name: "mcp__sh__run",
            call_id: "call_sh",
          },
        ],
      },
    };
    const map = new Map<string, ToolIdentityValue>([
      ["sanitized_exec", "exec_command"],
      ["mcp__sh__run", { namespace: "mcp__sh", name: "run" }],
    ]);
    const changed = restoreResponsesPassthroughFunctionCallIdentity(event, map);
    assert.equal(changed, true);
    const output = (
      event.response as {
        output: Array<{ name: string; namespace?: string }>;
      }
    ).output;
    assert.equal(output[0].name, "exec_command");
    assert.equal(output[0].namespace, undefined);
    assert.equal(output[1].name, "run");
    assert.equal(output[1].namespace, "mcp__sh");
  });

  it("restores ordinary Codex local tool (exec_command) preserving identity", () => {
    const event = {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_local",
      },
    };
    const map = new Map<string, ToolIdentityValue>([["exec_command", "exec_command"]]);
    restoreResponsesPassthroughFunctionCallIdentity(event, map);
    assert.equal(event.item.name, "exec_command");
  });
});

// ---------------------------------------------------------------------------
// 5. Realistic Antigravity non-stream web_search_preview pipeline test
// ---------------------------------------------------------------------------

describe("Antigravity explicit web_search_preview pipeline integration", () => {
  const originalFetch = globalThis.fetch;

  it("restores omniroute_web_search identity and executes server-side search", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];

    globalThis.fetch = async (url, init = {}) => {
      const urlStr = String(url);
      if (urlStr.includes("antigravity-auto-updater")) {
        return new Response(JSON.stringify({ releases: [] }), { status: 200 });
      }

      // Search execution fallback (DuckDuckGo free lite HTML)
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

      // Upstream Antigravity call (SSE stream with functionCall)
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
            },
          ],
          usageMetadata: {
            promptTokenCount: 15,
            candidatesTokenCount: 12,
            totalTokenCount: 27,
          },
        },
      };

      return new Response(`data: ${JSON.stringify(geminiChunk)}\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    try {
      const body = {
        model: "claude-opus-4-6-thinking",
        stream: false,
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Search for Antigravity release notes",
              },
            ],
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
        log: { debug() {}, info() {}, warn() {}, error() {} },
        clientRawRequest: {
          endpoint: "/v1/responses",
          body: structuredClone(body),
          headers: new Headers({ accept: "application/json" }),
          userAgent: "antigravity-regression-test",
        },
        never: Promise.resolve(new Response()),
      });

      assert.equal(result.success, true);
      const json = await result.response.json();
      assert.ok(Array.isArray(json.output), "output must be an array");

      // 1. Function call retains name "omniroute_web_search"
      type OutputItem = {
        type: string;
        name?: string;
        status?: string;
        action?: {
          type?: string;
          query?: string;
          sources?: Array<{ title: string; url?: string }>;
        };
        output?: unknown;
      };
      const functionCall = json.output.find((item: OutputItem) => item.type === "function_call");
      assert.ok(functionCall, "expected function_call output item");
      assert.equal(functionCall.name, "omniroute_web_search");

      // 2. Native web_search_call output item appended with sources
      const webSearchCall = json.output.find((item: OutputItem) => item.type === "web_search_call");
      assert.ok(webSearchCall, "expected web_search_call output item");
      assert.equal(webSearchCall.status, "completed");
      assert.equal(webSearchCall.action?.type, "web_search");
      assert.equal(webSearchCall.action?.query, "Antigravity release notes");
      assert.ok(Array.isArray(webSearchCall.action?.sources), "expected sources array");
      assert.ok(webSearchCall.action.sources.length > 0, "sources not empty");
      assert.equal(webSearchCall.action.sources[0].title, "Antigravity Release Notes");

      // 3. function_call_output appended
      const functionCallOutput = json.output.find(
        (item: OutputItem) => item.type === "function_call_output"
      );
      assert.ok(functionCallOutput, "expected function_call_output item");
      const parsedOutput =
        typeof functionCallOutput.output === "string"
          ? JSON.parse(functionCallOutput.output)
          : functionCallOutput.output;
      assert.equal(parsedOutput.success, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  after(async () => {
    await closeCallLogArtifactWriter(0);
  });
});
