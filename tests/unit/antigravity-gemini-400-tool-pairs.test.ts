import { prepareWebSearchFallbackBody } from "../../open-sse/services/webSearchFallback.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { buildAntigravityUpstreamError } from "../../open-sse/executors/antigravityUpstreamError.ts";
import {
  logAntigravityUpstreamFailureTelemetry,
  buildFinalAntigravityResult,
} from "../../open-sse/executors/antigravity/executeAttempt.ts";
import { fixToolPairs } from "../../open-sse/services/contextManager.ts";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";
import { markAccountUnavailable } from "../../src/sse/services/auth.ts";
import {
  getProviderConnections,
  createProviderConnection,
  deleteProviderConnection,
} from "../../src/lib/db/providers.ts";

test("1. response body HTTP 400 Antigravity preservado e sanitizado", () => {
  const rawGoogle400 = JSON.stringify({
    error: {
      code: 400,
      message: "Request contains invalid argument.",
      status: "INVALID_ARGUMENT",
    },
  });

  const errorBody = buildAntigravityUpstreamError(400, "Bad Request", rawGoogle400);
  assert.ok(errorBody.error, "must contain error object");
  assert.ok(
    errorBody.error.message.includes("Request contains invalid argument."),
    "preserves real Google error message"
  );
  assert.equal(errorBody.error.code, "INVALID_ARGUMENT", "preserves Google status code");
  assert.equal(errorBody.error.type, "invalid_request_error");
  assert.ok(!errorBody.error.message.includes("at /"), "no stack trace leaked");

  // Non-JSON upstream body handles safely
  const htmlError = buildAntigravityUpstreamError(
    400,
    "Bad Request",
    "<html><body>Bad Request</body></html>"
  );
  assert.ok(htmlError.error);
  assert.ok(!htmlError.error.message.includes("<html>"));
});

test("2. structured telemetry log format without secret leakage", () => {
  let loggedTag = "";
  const mockLog = {
    debug: () => {},
    info: () => {},
    warn: (tag: string) => {
      loggedTag = tag;
    },
    error: () => {},
  };

  const secretToken = "AIzaSyD-secret-token-1234567890abcdef";
  const secretAuth = "Bearer ya29.a0AfH6SM-secret-access-token";
  const rawBodyWithSecret = JSON.stringify({
    error: {
      code: 400,
      message: `Request contains invalid argument. Authorization: ${secretAuth}`,
      status: "INVALID_ARGUMENT",
    },
    accessToken: secretToken,
  });

  const transformedBody = {
    request: {
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ functionCall: { id: "call_1", name: "write_stdin" } }] },
      ],
      tools: [
        {
          functionDeclarations: [{ name: "write_stdin" }, { name: "exec_command" }],
        },
      ],
    },
  };

  const line = logAntigravityUpstreamFailureTelemetry(
    mockLog,
    "gemini-3.8-flash-tiered",
    400,
    rawBodyWithSecret,
    transformedBody
  );

  assert.equal(loggedTag, "TELEMETRY");
  assert.ok(line.includes("provider=antigravity"));
  assert.ok(line.includes("model=gemini-3.8-flash-tiered"));
  assert.ok(line.includes("status=400"));
  assert.ok(line.includes("errorClass=request_validation"));
  assert.ok(line.includes("upstreamCode=INVALID_ARGUMENT"));
  assert.ok(line.includes("retryable=false"));
  assert.ok(line.includes("accountSpecific=false"));
  assert.ok(line.includes("payloadFingerprint="));
  assert.ok(line.includes("messages=2"));
  assert.ok(line.includes("tools=2"));

  // Secrets MUST NOT appear
  assert.ok(!line.includes(secretToken), "secretToken must not leak");
  assert.ok(!line.includes("ya29.a0AfH6SM"), "access token must not leak");
  assert.ok(!line.includes("hello"), "prompt text must not leak");
});

test("3. erro request-invalid não gira inutilmente por todas contas", async () => {
  let testConnId = "";
  try {
    const created = await createProviderConnection({
      provider: "antigravity",
      is_active: 1,
      test_status: "active",
    } as unknown as Parameters<typeof createProviderConnection>[0]);
    testConnId = created.id;

    const result = await markAccountUnavailable(
      testConnId,
      400,
      "Antigravity upstream error (400): Request contains invalid argument.",
      "antigravity",
      "gemini-3.8-flash-tiered",
      null
    );

    assert.equal(
      result.shouldFallback,
      false,
      "should not fallback on deterministic request validation"
    );
    assert.equal(result.cooldownMs, 0, "no cooldown on connection");
    assert.equal(result.reason, "request_validation");

    const connections = await getProviderConnections({ provider: "antigravity" });
    const conn = connections.find((c) => c.id === testConnId);
    assert.ok(conn, "connection exists");
    assert.notEqual(
      (conn as Record<string, unknown>).testStatus,
      "unavailable",
      "connection stays active"
    );
    assert.equal(
      (conn as Record<string, unknown>).lastErrorType,
      "request_validation",
      "recorded lastErrorType"
    );
    assert.equal(Number((conn as Record<string, unknown>).errorCode), 400);
  } finally {
    if (testConnId) await deleteProviderConnection(testConnId).catch(() => {});
  }
});

test("4. erro account-specific ainda pode fazer failover", async () => {
  let testConnId = "";
  try {
    const created = await createProviderConnection({
      provider: "antigravity",
      is_active: 1,
      test_status: "active",
    } as unknown as Parameters<typeof createProviderConnection>[0]);
    testConnId = created.id;

    // Auth error on 400 MUST fallback
    const authResult = await markAccountUnavailable(
      testConnId,
      400,
      "400 Invalid API key provided",
      "antigravity",
      "gemini-3.8-flash-tiered",
      null
    );
    assert.equal(authResult.shouldFallback, true, "auth 400 must trigger fallback");

    // Model access denial on 400 MUST fallback
    const accessResult = await markAccountUnavailable(
      testConnId,
      400,
      "400 User does not have permission to access model gemini-1.5-pro",
      "antigravity",
      "gemini-3.8-flash-tiered",
      null
    );
    assert.equal(accessResult.shouldFallback, true, "permission 400 must trigger fallback");
  } finally {
    if (testConnId) await deleteProviderConnection(testConnId).catch(() => {});
  }
});

test("5. compressão / fixToolPairs não deixa functionCall órfão", () => {
  const messages = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      tool_calls: [
        { id: "call_orphan_1", type: "function", function: { name: "test_fn", arguments: "{}" } },
      ],
    },
    // Notice: no tool response for call_orphan_1!
    { role: "user", content: "followup question" },
  ];

  const fixed = fixToolPairs(messages);
  const assistantMsg = fixed.find((m) => m.role === "assistant") as
    Record<string, unknown> | undefined;
  const toolCalls = assistantMsg?.tool_calls as unknown[] | undefined;
  assert.ok(!assistantMsg || !toolCalls || toolCalls.length === 0, "orphan tool call stripped");
});

test("6. compressão / fixToolPairs não deixa functionResponse órfão", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "tool", tool_call_id: "call_no_match", content: "orphan response" },
  ];

  const fixed = fixToolPairs(messages);
  const toolMsg = fixed.find((m) => m.role === "tool");
  assert.equal(toolMsg, undefined, "orphan tool response stripped");
});

test("7. ordem necessária dos pares tools e desambiguação de IDs duplicados", () => {
  const messages = [
    { role: "user", content: "step 1" },
    {
      role: "assistant",
      tool_calls: [
        { id: "call_120666", type: "function", function: { name: "write_stdin", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_120666", content: "stdin written" },
    { role: "user", content: "step 2" },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_120666",
          type: "function",
          function: { name: "exec_command", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_120666", content: "command executed" },
  ];

  const fixed = fixToolPairs(messages);
  assert.equal(fixed.length, 6);

  // First turn keeps call_120666
  const tcs1 = fixed[1].tool_calls as Array<{ id: string }>;
  assert.equal(tcs1[0].id, "call_120666");
  assert.equal(fixed[2].tool_call_id, "call_120666");

  // Second turn is disambiguated to call_120666_2
  const tcs2 = fixed[4].tool_calls as Array<{ id: string }>;
  assert.equal(tcs2[0].id, "call_120666_2");
  assert.equal(fixed[5].tool_call_id, "call_120666_2");

  // Idempotence check
  const fixedAgain = fixToolPairs(fixed);
  assert.deepEqual(fixedAgain, fixed, "fixToolPairs is idempotent");
});

test("8. sessão longa com tools duplicadas gera payload Gemini válido", () => {
  const chatRequest = {
    messages: [
      { role: "user", content: "step 1" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_120666",
            type: "function",
            function: { name: "write_stdin", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_120666", content: "output 1" },
      { role: "user", content: "step 2" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_120666",
            type: "function",
            function: { name: "exec_command", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_120666", content: "output 2" },
    ],
    tools: [
      { type: "function", function: { name: "write_stdin", parameters: { type: "object" } } },
      { type: "function", function: { name: "exec_command", parameters: { type: "object" } } },
    ],
  };

  const agy = openaiToAntigravityRequest("gemini-3.8-flash-tiered", chatRequest, true) as {
    request?: {
      contents: Array<{
        parts?: Array<{
          functionCall?: { id?: string };
          functionResponse?: { id?: string };
        }>;
      }>;
    };
  };
  assert.ok(agy.request, "has cloudCode request envelope");
  const contents = agy.request.contents;

  // Collect all functionCall and functionResponse IDs
  const callIds: string[] = [];
  const respIds: string[] = [];

  for (const c of contents) {
    for (const p of c.parts || []) {
      if (p.functionCall?.id) callIds.push(p.functionCall.id);
      if (p.functionResponse?.id) respIds.push(p.functionResponse.id);
    }
  }

  assert.deepEqual(callIds, ["call_120666", "call_120666_2"], "functionCall IDs disambiguated");
  assert.deepEqual(
    respIds,
    ["call_120666", "call_120666_2"],
    "functionResponse IDs match functionCall IDs"
  );

  // Ensure no duplicate IDs in callIds
  const uniqueCallIds = new Set(callIds);
  assert.equal(uniqueCallIds.size, callIds.length, "all functionCall IDs unique");
});

test("9. Native Codex stream continua funcionando e sanitiza erro 400 em streaming", async () => {
  const rawGoogle400 = JSON.stringify({
    error: {
      code: 400,
      message: "Request contains invalid argument.",
      status: "INVALID_ARGUMENT",
    },
  });

  const response = new Response(rawGoogle400, {
    status: 400,
    statusText: "Bad Request",
    headers: { "content-type": "application/json" },
  });

  const result = await buildFinalAntigravityResult(
    true, // stream: true
    response,
    "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    {},
    { request: { contents: [], tools: [] } },
    "acc_123",
    null,
    () => {},
    null,
    "gemini-3.8-flash-tiered"
  );

  assert.equal(result.response.status, 400);
  const json = (await result.response.json()) as { error: { code: string; message: string } };
  assert.ok(json.error);
  assert.equal(json.error.code, "INVALID_ARGUMENT");
  assert.ok(json.error.message.includes("Request contains invalid argument."));
});

test("10. web_search fallback continua funcionando", () => {
  const prepared = prepareWebSearchFallbackBody(
    {
      model: "Codex",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "search query" }] },
      ],
      tools: [
        { type: "web_search" },
        { type: "function", function: { name: "exec_command", parameters: {} } },
      ],
    },
    {
      provider: "antigravity",
      sourceFormat: "openai-responses",
      targetFormat: "gemini",
      interceptSearchOverride: true,
      nativeCodexPassthrough: false,
    }
  );
  assert.equal(prepared.fallback.enabled, true);
  assert.equal(prepared.fallback.toolName, "omniroute_web_search");
  assert.equal(prepared.fallback.convertedToolCount, 1);

  const agy = openaiToAntigravityRequest(
    "gemini-3.8-flash-tiered",
    {
      messages: [{ role: "user", content: "search query" }],
      tools: prepared.body.tools as Array<Record<string, unknown>>,
    },
    true
  ) as {
    request?: {
      tools: Array<{
        functionDeclarations: Array<{ name: string }>;
      }>;
    };
  };
  assert.ok(agy.request);
  const decls = agy.request.tools[0].functionDeclarations;
  assert.ok(decls.some((d) => d.name === "omniroute_web_search"));
});

test("11. múltiplas duplicatas do mesmo ID (id_2, id_3) e tool responses separadas", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f1" } }] },
    { role: "tool", tool_call_id: "c1", content: "r1" },
    { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f2" } }] },
    { role: "tool", tool_call_id: "c1", content: "r2" },
    { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f3" } }] },
    { role: "tool", tool_call_id: "c1", content: "r3" },
  ];
  const fixed = fixToolPairs(messages);
  assert.equal((fixed[0].tool_calls as Record<string, unknown>[])[0].id, "c1");
  assert.equal(fixed[1].tool_call_id, "c1");
  assert.equal((fixed[2].tool_calls as Record<string, unknown>[])[0].id, "c1_2");
  assert.equal(fixed[3].tool_call_id, "c1_2");
  assert.equal((fixed[4].tool_calls as Record<string, unknown>[])[0].id, "c1_3");
  assert.equal(fixed[5].tool_call_id, "c1_3");
});

test("12. mais de uma tool call na mesma mensagem com ID duplicado", () => {
  const messages: Array<Record<string, unknown>> = [
    {
      role: "assistant",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "f1" } },
        { id: "c1", type: "function", function: { name: "f2" } },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "r1" },
    { role: "tool", tool_call_id: "c1", content: "r2" },
  ];
  const fixed = fixToolPairs(messages);
  const tcs = fixed[0].tool_calls as Record<string, unknown>[];
  assert.equal(tcs[0].id, "c1");
  assert.equal(tcs[1].id, "c1_2");
  assert.equal(fixed[1].tool_call_id, "c1");
  assert.equal(fixed[2].tool_call_id, "c1_2");
});

test("13. tool_use e tool_use_id em blocos de conteúdo (Claude format)", () => {
  const messages: Array<Record<string, unknown>> = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu_1", name: "f1" },
        { type: "tool_use", id: "tu_1", name: "f2" },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "res1" },
        { type: "tool_result", tool_use_id: "tu_1", content: "res2" },
      ],
    },
  ];
  const fixed = fixToolPairs(messages);
  const asstBlocks = fixed[0].content as Record<string, unknown>[];
  assert.equal(asstBlocks[0].id, "tu_1");
  assert.equal(asstBlocks[1].id, "tu_1_2");
  const userBlocks = fixed[1].content as Record<string, unknown>[];
  assert.equal(userBlocks[0].tool_use_id, "tu_1");
  assert.equal(userBlocks[1].tool_use_id, "tu_1_2");
});

test("14. pruning/compressão preserva pares desambiguados e mantém integridade", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: "start" },
    { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f1" } }] },
    { role: "tool", tool_call_id: "c1", content: "res1" },
    { role: "user", content: "middle" },
    { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f2" } }] },
    { role: "tool", tool_call_id: "c1", content: "res2" },
  ];
  const pass1 = fixToolPairs(messages);
  // Simulate pruning turn 1 (dropping first 3 messages)
  const pruned = pass1.slice(3);
  const pass2 = fixToolPairs(pruned);
  assert.equal(pass2.length, 3);
  assert.equal((pass2[1].tool_calls as Record<string, unknown>[])[0].id, "c1_2");
  assert.equal(pass2[2].tool_call_id, "c1_2");
});
