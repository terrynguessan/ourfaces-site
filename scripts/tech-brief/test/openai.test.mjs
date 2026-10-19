import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAIError,
  classifyHttpError,
  createClient,
  createMeter,
  fetchTransport,
  parseResponse,
  worstCaseUsd,
} from "../openai.mjs";
import { loadConfig } from "../research.mjs";
import { fixtureJson } from "./helpers.mjs";
import { USAGE, errorOf, rateLimitOf, responseOf } from "./openai-mock.mjs";

const config = await loadConfig();
const meterFor = (overrides = {}) =>
  createMeter({
    prices: config.prices,
    perRunUsd: config.budget.perRunUsd,
    retriesPerRun: config.limits.retriesPerRun,
    ...overrides,
  });

const writingRequest = {
  model: "gpt-6.1-sol",
  reasoningEffort: "medium",
  maxOutputTokens: 16000,
  instructions: "Write.",
  input: "TASK DATA:\n{}",
  schemaName: "review",
};
const validReview = {
  stories: [
    {
      key: "k1",
      faithful: true,
      unsupportedSentences: [],
      translationIssues: [],
      copyrightConcern: false,
    },
  ],
};

function scripted(responses) {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, calls };
}

function clientWith(responses, meter = meterFor()) {
  const waits = [];
  const { transport, calls } = scripted(responses);
  const client = createClient({
    transport,
    config,
    meter,
    wait: async (ms) => waits.push(ms),
  });
  return { client, calls, waits, meter };
}

test("request body: strict schema, store false, standard tier, no Flex", () => {
  const { client } = clientWith([]);
  const body = client.buildBody({
    ...writingRequest,
    model: "gpt-6-luna",
    schemaName: "discovery",
    tools: [
      {
        type: "web_search",
        filters: { blocked_domains: ["bit.ly"] },
        search_context_size: "medium",
      },
    ],
    toolChoice: "required",
    maxToolCalls: 5,
    include: ["web_search_call.action.sources"],
  });
  assert.equal(body.store, false);
  assert.equal(body.service_tier, "default");
  assert.deepEqual(body.reasoning, { effort: "medium" });
  assert.equal(body.max_output_tokens, 16000);
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.name, "discovery");
  assert.equal(body.tool_choice, "required");
  assert.equal(body.max_tool_calls, 5);
  assert.deepEqual(body.include, ["web_search_call.action.sources"]);
  assert.ok(!JSON.stringify(body).includes("flex"));
});

test("parseResponse reads searches, sources, citations and usage from a documented-shape fixture", () => {
  const parsed = parseResponse(fixtureJson("openai/discovery-response.json"));
  assert.equal(parsed.status, "completed");
  assert.equal(
    parsed.searchCount,
    2,
    "every web_search_call item counts, including open_page actions",
  );
  assert.deepEqual(parsed.sources, [
    "https://news.alpha-devtools.com/releases/v5-0",
    "https://www.gamma-journal.org/articles/2026/10/test-flakiness-study",
  ]);
  assert.deepEqual(parsed.citations, [
    "https://news.alpha-devtools.com/releases/v5-0",
  ]);
  assert.equal(JSON.parse(parsed.text).candidates.length, 1);
  assert.equal(parsed.usage.input_tokens_details.cached_tokens, 5000);
});

test("cost meter prices tokens, cached tokens, reasoning (in output) and searches", () => {
  const meter = meterFor();
  const usage = fixtureJson("openai/discovery-response.json").usage;
  // Luna: (45000-5000)*0.10 + 5000*0.01 + 6000*0.50 per 1M, plus 2 searches * $0.01
  assert.equal(meter.price("gpt-6-luna", usage, 2), 0.02705);
  const sol = {
    input_tokens: 4000,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 9000,
    output_tokens_details: { reasoning_tokens: 6000 },
  };
  assert.equal(meter.price("gpt-6.1-sol", sol, 0), 0.098);
  assert.throws(
    () => meter.price("gpt-unknown", sol, 0),
    (e) => e.kind === "BAD_REQUEST",
    "no price, no call (no substitution)",
  );
});

test("worst-case estimate covers prompt, maximum output and maximum searches", () => {
  const discovery = {
    model: "gpt-6-luna",
    tools: [{ type: "web_search" }],
    maxToolCalls: 5,
    maxOutputTokens: 12000,
    instructions: "x".repeat(3000),
    input: "y".repeat(300),
  };
  // Items: max_tool_calls 5 + 2 allowance = 7.
  // (1100 prompt + 7*30000 search tokens) * 0.10 + 12000 * 0.50, per 1M, + 7 * $0.01
  assert.equal(worstCaseUsd(discovery, config), 0.09711);
});

test("classifyHttpError separates quota, rate limit, auth, server and request errors", () => {
  for (const code of [
    "project_spend_limit_exceeded",
    "organization_spend_limit_exceeded",
    "credit_balance_exhausted",
    "organization_usage_limit_exceeded",
  ]) {
    assert.equal(
      classifyHttpError(429, errorOf(429, code).json).kind,
      "QUOTA",
      code,
    );
  }
  assert.equal(classifyHttpError(429, rateLimitOf(2).json).kind, "RATE_LIMIT");
  assert.equal(
    classifyHttpError(401, errorOf(401, "invalid_api_key").json).kind,
    "AUTH",
  );
  assert.equal(
    classifyHttpError(503, errorOf(503, "server_is_overloaded").json).kind,
    "SERVER",
  );
  assert.equal(
    classifyHttpError(400, errorOf(400, "invalid_request").json).kind,
    "BAD_REQUEST",
  );
});

test("a valid structured response is parsed, validated and priced", async () => {
  const { client, meter } = clientWith([
    responseOf({
      model: "gpt-6.1-sol",
      json: validReview,
      usage: USAGE.review,
    }),
  ]);
  const result = await client.respond("review", writingRequest);
  assert.deepEqual(result.json, validReview);
  assert.equal(meter.billedEstimateUsd, 0.032);
  assert.equal(meter.calls[0].reasoningTokens, 1200);
});

test("spending-limit errors stop immediately and are never retried", async () => {
  const { client, calls } = clientWith([
    errorOf(
      429,
      "project_spend_limit_exceeded",
      "Your project reached its enforced spend limit.",
    ),
    responseOf({ json: validReview }),
  ]);
  await assert.rejects(
    client.respond("review", writingRequest),
    (e) => e.kind === "QUOTA",
  );
  assert.equal(calls.length, 1);
});

test("rate limits are retried once after Retry-After", async () => {
  const { client, calls, waits } = clientWith([
    rateLimitOf(7),
    responseOf({ model: "gpt-6.1-sol", json: validReview }),
  ]);
  await client.respond("review", writingRequest);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [7000]);
});

test("server errors are retried once per call, then fail", async () => {
  const { client, calls } = clientWith([
    errorOf(500, "server_error"),
    errorOf(500, "server_error"),
    responseOf({ json: validReview }),
  ]);
  await assert.rejects(
    client.respond("review", writingRequest),
    (e) => e.kind === "SERVER",
  );
  assert.equal(calls.length, 2);
});

test("the run-wide retry allowance is shared across calls", async () => {
  const meter = meterFor({ retriesPerRun: 1 });
  const { client, calls } = clientWith(
    [
      errorOf(500, "x"),
      responseOf({ model: "gpt-6.1-sol", json: validReview }),
      errorOf(500, "x"),
    ],
    meter,
  );
  await client.respond("review", writingRequest);
  await assert.rejects(
    client.respond("review", writingRequest),
    (e) => e.kind === "SERVER",
  );
  assert.equal(calls.length, 3, "second call had no retry left");
});

test("bad requests and auth errors are not retried", async () => {
  for (const [status, code] of [
    [400, "invalid_request"],
    [401, "invalid_api_key"],
  ]) {
    const { client, calls } = clientWith([
      errorOf(status, code),
      responseOf({ json: validReview }),
    ]);
    await assert.rejects(client.respond("review", writingRequest));
    assert.equal(calls.length, 1);
  }
});

test("timeouts are retried and their worst case is counted as an unknown charge", async () => {
  const { client, meter, calls } = clientWith([
    new OpenAIError("TIMEOUT", "slow"),
    new OpenAIError("TIMEOUT", "slow"),
  ]);
  await assert.rejects(
    client.respond("review", writingRequest),
    (e) => e.kind === "TIMEOUT",
  );
  assert.equal(calls.length, 2);
  const worst = worstCaseUsd(writingRequest, config);
  assert.equal(meter.unknownChargesUsd, Math.round(2 * worst * 1e6) / 1e6);
  assert.equal(meter.billedEstimateUsd, 0);
});

test("incomplete responses are billed and rejected", async () => {
  const { client, meter } = clientWith([
    responseOf({
      model: "gpt-6.1-sol",
      json: validReview,
      status: "incomplete",
      incompleteReason: "max_output_tokens",
      usage: USAGE.review,
    }),
  ]);
  await assert.rejects(
    client.respond("review", writingRequest),
    (e) => e.kind === "INCOMPLETE" && /max_output_tokens/.test(e.message),
  );
  assert.equal(meter.billedEstimateUsd, 0.032);
});

test("refusals, invalid JSON and schema violations are rejected", async () => {
  const cases = [
    [responseOf({ refusal: "I can't help with that." }), "REFUSAL"],
    [responseOf({ text: "{not json" }), "INVALID_OUTPUT"],
    [
      responseOf({
        json: { stories: [{ ...validReview.stories[0], extra: true }] },
      }),
      "INVALID_OUTPUT",
    ],
    [
      responseOf({
        json: { stories: [{ ...validReview.stories[0], key: "story-1" }] },
      }),
      "INVALID_OUTPUT",
    ],
    [
      responseOf({
        json: {
          stories: [
            {
              key: "k1",
              faithful: "yes",
              unsupportedSentences: [],
              translationIssues: [],
              copyrightConcern: false,
            },
          ],
        },
      }),
      "INVALID_OUTPUT",
    ],
  ];
  for (const [response, kind] of cases) {
    const { client } = clientWith([response]);
    await assert.rejects(
      client.respond("review", writingRequest),
      (e) => e.kind === kind,
    );
  }
});

test("a response without usage data counts its worst case as unknown", async () => {
  const { client, meter } = clientWith([
    responseOf({ json: validReview, usage: null }),
  ]);
  await client.respond("review", writingRequest);
  assert.equal(meter.unknownChargesUsd, worstCaseUsd(writingRequest, config));
});

test("the per-run ceiling blocks a call before anything is sent", async () => {
  const meter = meterFor({ perRunUsd: 0.05 });
  const { client, calls } = clientWith(
    [responseOf({ json: validReview })],
    meter,
  );
  await assert.rejects(
    client.respond("review", writingRequest),
    (e) => e.kind === "BUDGET",
  );
  assert.equal(calls.length, 0);
});

test("listModels reads model IDs; errors are classified", async () => {
  const { client } = clientWith([
    {
      status: 200,
      headers: {},
      json: { data: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }] },
    },
  ]);
  assert.deepEqual(await client.listModels(), ["gpt-6-luna", "gpt-6.1-sol"]);
  const failing = clientWith([errorOf(401, "invalid_api_key")]);
  await assert.rejects(failing.client.listModels(), (e) => e.kind === "AUTH");
});

test("fetchTransport sends the key only in the Authorization header and never leaks it", async () => {
  // Deliberately not shaped like a real key, so secret scanners stay quiet.
  const key = "placeholder-test-value-0123456789";
  const original = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "retry-after": "3" },
      });
    };
    const transport = fetchTransport({
      apiKey: key,
      baseUrl: config.apiBaseUrl,
    });
    const result = await transport({
      method: "POST",
      path: "/responses",
      body: { a: 1 },
      timeoutMs: 1000,
    });
    assert.equal(seen[0].url, "https://api.openai.com/v1/responses");
    assert.equal(seen[0].init.headers.authorization, `Bearer ${key}`);
    assert.equal(seen[0].init.redirect, "error");
    assert.equal(result.headers["retry-after"], "3");

    globalThis.fetch = async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    };
    const error = await transport({
      method: "POST",
      path: "/responses",
      body: {},
      timeoutMs: 1000,
    }).catch((e) => e);
    assert.equal(error.kind, "NETWORK");
    assert.ok(
      !JSON.stringify({
        message: error.message,
        details: error.details,
      }).includes(key),
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.throws(
    () => fetchTransport({ apiKey: "", baseUrl: config.apiBaseUrl }),
    (e) => e.kind === "AUTH",
  );
  assert.throws(
    () => fetchTransport({ apiKey: key, baseUrl: "http://api.openai.com/v1" }),
    (e) => e.kind === "BAD_REQUEST",
  );
});

// --- F2: web search actions, conservative estimates and overrun detection ---

const discoveryRequest = {
  model: "gpt-6-luna",
  reasoningEffort: "medium",
  maxOutputTokens: 12000,
  instructions: "x".repeat(3000),
  input: "y".repeat(300),
  tools: [{ type: "web_search" }],
  toolChoice: "required",
  maxToolCalls: 5,
  include: ["web_search_call.action.sources"],
};

test("parseResponse separates billable search actions from page-open and find actions", () => {
  const parsed = parseResponse(fixtureJson("openai/discovery-response.json"));
  assert.equal(parsed.searchCount, 2);
  assert.equal(parsed.billableSearchCount, 1);
  assert.equal(parsed.otherActionCount, 1);
  assert.deepEqual(
    parsed.actions.map((a) => [a.type, a.billable, a.sources]),
    [
      ["search", true, 2],
      ["open_page", false, 0],
    ],
  );
  assert.deepEqual(parsed.actionUrls, [
    "https://news.alpha-devtools.com/releases/v5-0",
  ]);
  assert.deepEqual(parsed.actions[0].queries, [
    "type checker incremental mode release October 2026",
  ]);

  const mixed = responseOf({
    actions: [
      { type: "search", queries: ["a", "b"] },
      { type: "find_in_page", url: "https://example.com/x" },
      { type: "find" },
      {},
    ],
  }).json;
  const p = parseResponse(mixed);
  assert.equal(
    p.billableSearchCount,
    2,
    "search and a missing type are billable",
  );
  assert.equal(p.otherActionCount, 2);
  assert.deepEqual(p.actions[3].type, "unknown");
  assert.deepEqual(p.actionUrls, ["https://example.com/x"]);
});

test("a web search request without max_tool_calls is refused as unbounded", () => {
  for (const maxToolCalls of [undefined, 0, -1, 2.5]) {
    assert.throws(
      () => worstCaseUsd({ ...discoveryRequest, maxToolCalls }, config),
      (e) => e.kind === "BUDGET",
      String(maxToolCalls),
    );
  }
});

test("run-26e47111 pattern: 5 searches + 1 page open is priced and counted conservatively, without overrun", async () => {
  const response = responseOf({
    json: { candidates: [] },
    actions: [
      ...Array.from({ length: 5 }, () => ({ type: "search" })),
      { type: "open_page", url: "https://example.com/a" },
    ],
    usage: { input: 47_669, cached: 0, output: 2_091, reasoning: 1_613 },
  });
  const { client, meter } = clientWith([response]);
  const result = await client.respond("discovery", {
    ...discoveryRequest,
    schemaName: "discovery",
  });
  // Billed estimate: 47669*0.10 + 2091*0.50 per 1M + 5 searches.
  assert.equal(result.costUsd, 0.055812);
  const call = meter.calls[0];
  assert.deepEqual(
    [call.searches, call.otherActions, call.toolItems, call.searchLimit],
    [5, 1, 6, 5],
  );
  assert.equal(
    call.unknownChargeUsd,
    0.01,
    "the page open counted at the search price",
  );
  assert.equal(meter.spentUsd, 0.065812, "same counted total as the dry run");
  assert.ok(
    meter.spentUsd <= call.worstCaseUsd,
    "now within the pre-call estimate",
  );
  assert.deepEqual(meter.overruns, []);
});

test("more web search items than budgeted stop the run as an estimate overrun", async () => {
  const response = responseOf({
    json: { candidates: [] },
    actions: Array.from({ length: 8 }, () => ({ type: "search" })),
    usage: { input: 50_000, cached: 0, output: 2_000, reasoning: 0 },
  });
  const { client, meter } = clientWith([response, response]);
  await assert.rejects(
    client.respond("discovery", {
      ...discoveryRequest,
      schemaName: "discovery",
    }),
    (e) =>
      e.kind === "BUDGET" &&
      /Estimate overrun/.test(e.message) &&
      e.details.overrun.toolItemBudget === 7,
  );
  assert.equal(meter.overruns.length, 1);
  assert.ok(meter.spentUsd > 0, "the overrunning call is still counted");
});

test("token usage above the estimate is also detected as an overrun", async () => {
  const response = responseOf({
    model: "gpt-6.1-sol",
    json: validReview,
    usage: { input: 3_000_000, cached: 0, output: 100, reasoning: 0 },
  });
  const { client, meter } = clientWith([response]);
  await assert.rejects(
    client.respond("review", writingRequest),
    (e) => e.kind === "BUDGET",
  );
  assert.equal(meter.overruns[0].stage, "review");
});
