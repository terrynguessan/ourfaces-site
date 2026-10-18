// Offline tests for the capability probe: scripted transport only.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PROBE_MAX_USD,
  probePlan,
  probeWorstCaseUsd,
  runProbe,
} from "../probe.mjs";
import { loadConfig } from "../research.mjs";
import { errorOf, responseOf } from "./openai-mock.mjs";

const config = await loadConfig();
const MODELS = {
  status: 200,
  headers: {},
  json: {
    data: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
  },
};
const SOURCES = [
  "https://nodejs.org/en/about/previous-releases",
  "https://devguide.python.org/versions/",
];
const USAGE_SMALL = { input: 60, cached: 0, output: 180, reasoning: 120 };
const USAGE_SEARCH = { input: 9_500, cached: 0, output: 400, reasoning: 250 };

/** Default responses for each request; `overrides[id]` replaces one. */
function transportFor(overrides = {}) {
  const requests = [];
  const fn = async (request) => {
    const id =
      request.method === "GET"
        ? request.path === "/models"
          ? "P1"
          : "P6"
        : request.body.tools
          ? request.body.text
            ? "P5"
            : "P4"
          : request.body.model === "gpt-6.1-sol"
            ? "P3"
            : "P2";
    requests.push({ id, request });
    if (overrides[id]) {
      const value =
        typeof overrides[id] === "function"
          ? overrides[id](request)
          : overrides[id];
      if (value instanceof Error) throw value;
      return value;
    }
    switch (id) {
      case "P1":
        return MODELS;
      case "P2":
      case "P3": {
        const r = responseOf({
          model: request.body.model,
          json: { answer: "ok" },
          usage: USAGE_SMALL,
        });
        r.json.id = `resp_${id}`;
        r.json.store = false;
        return r;
      }
      case "P4":
        return responseOf({
          text: "The Node.js release schedule is on nodejs.org.",
          searches: 1,
          sources: SOURCES,
          citations: [SOURCES[0]],
          usage: USAGE_SEARCH,
        });
      case "P5":
        return responseOf({
          json: { url: SOURCES[0], title: "Node.js releases" },
          searches: 1,
          sources: SOURCES,
          citations: [SOURCES[0]],
          usage: USAGE_SEARCH,
        });
      case "P6":
        return {
          status: 404,
          headers: {},
          json: {
            error: {
              message: "Response not found",
              type: "invalid_request_error",
              code: null,
            },
          },
        };
      default:
        throw new Error("unexpected");
    }
  };
  return { fn, requests };
}

const ids = (requests) => requests.map((r) => r.id);

test("the plan sends minimal, store:false, standard-tier requests within the documented limits", () => {
  const plan = probePlan(config);
  assert.deepEqual(
    plan.map((s) => s.id),
    ["P2", "P3", "P4", "P5"],
  );
  for (const step of plan) {
    assert.equal(step.body.store, false);
    assert.equal(step.body.service_tier, "default");
    assert.equal(step.body.reasoning.effort, "low");
    if (step.body.text) assert.equal(step.body.text.format.strict, true);
    if (step.body.tools) {
      assert.equal(step.body.max_tool_calls, 1);
      assert.equal(step.body.tool_choice, "required");
      assert.deepEqual(step.body.include, ["web_search_call.action.sources"]);
    }
  }
  assert.deepEqual(
    [...new Set(plan.map((s) => s.body.model))],
    ["gpt-6-luna", "gpt-6.1-sol"],
  );
  const worst = plan.reduce((sum, s) => sum + probeWorstCaseUsd(s, config), 0);
  assert.ok(worst <= PROBE_MAX_USD, `planned worst case ${worst}`);
  assert.equal(Math.round(worst * 1e6) / 1e6, 0.058306);
});

test("all capabilities present: every finding is recorded with measured usage and cost", async () => {
  const t = transportFor();
  const report = await runProbe({ transport: t.fn, config, maxUsd: 0.1 });
  assert.equal(report.status, "completed", report.stopReason);
  assert.deepEqual(ids(t.requests), ["P1", "P2", "P3", "P4", "P5", "P6"]);
  assert.deepEqual(report.findings, {
    modelsAvailable: { "gpt-6-luna": true, "gpt-6.1-sol": true },
    lunaStructuredOutput: true,
    reasoningTokensReported: true,
    solStructuredOutput: true,
    webSearch: true,
    maxToolCalls: "accepted and respected",
    sourcesReported: true,
    searchTokensInInput: true,
    webSearchWithStrictSchema: "supported",
    storeFalseHonoured: true,
  });
  for (const r of report.results.filter((x) =>
    ["P2", "P3", "P4", "P5"].includes(x.id),
  )) {
    assert.equal(r.verdict, "pass", `${r.id}: ${JSON.stringify(r.checks)}`);
    assert.ok(r.usage.reasoningTokens > 0);
    assert.equal(r.request.store, false);
  }
  // Luna: 60 in + 180 out; Sol: 60 in + 180 out; Luna search: 9500 in + 400 out + $0.01 (x2).
  assert.equal(report.results.find((r) => r.id === "P2").costUsd, 0.000096);
  assert.equal(report.results.find((r) => r.id === "P3").costUsd, 0.00192);
  assert.equal(report.results.find((r) => r.id === "P4").costUsd, 0.01115);
  assert.equal(report.totals.estimatedBilledUsd, 0.024316);
  assert.equal(report.totals.unknownChargesUsd, 0);
  assert.ok(report.recommendations.some((r) => r.includes('"auto"')));
});

test("a missing model stops the probe before any paid request; nothing is substituted", async () => {
  const t = transportFor({
    P1: { status: 200, headers: {}, json: { data: [{ id: "gpt-6-luna" }] } },
  });
  const report = await runProbe({ transport: t.fn, config, maxUsd: 0.1 });
  assert.equal(report.status, "stopped");
  assert.deepEqual(ids(t.requests), ["P1"]);
  assert.deepEqual(report.findings.modelsAvailable, {
    "gpt-6-luna": true,
    "gpt-6.1-sol": false,
  });
  assert.equal(report.totals.countedUsd, 0);
});

test("authentication failure on the free model list stops everything", async () => {
  const t = transportFor({
    P1: errorOf(401, "invalid_api_key", "Incorrect API key provided"),
  });
  const report = await runProbe({ transport: t.fn, config, maxUsd: 0.1 });
  assert.equal(report.status, "stopped");
  assert.match(report.stopReason, /AUTH/);
  assert.deepEqual(ids(t.requests), ["P1"]);
});

test("web search with a strict schema rejected: recorded, fallback recommended, probe continues", async () => {
  const t = transportFor({
    P5: errorOf(
      400,
      "invalid_request",
      "text.format json_schema is not supported with web_search",
    ),
  });
  const report = await runProbe({ transport: t.fn, config, maxUsd: 0.1 });
  assert.equal(report.status, "completed");
  assert.equal(report.findings.webSearchWithStrictSchema, "rejected");
  assert.ok(
    report.recommendations.some((r) =>
      r.includes("structuredOutputWithSearch = false"),
    ),
  );
  assert.deepEqual(ids(t.requests), ["P1", "P2", "P3", "P4", "P5", "P6"]);
});

test("max_tool_calls rejected: web search probes stop (no unbounded searches)", async () => {
  const rejected = {
    status: 400,
    headers: {},
    json: {
      error: {
        message: "max_tool_calls must be at least 16",
        type: "invalid_request_error",
        param: "max_tool_calls",
        code: "integer_below_min_value",
      },
    },
  };
  const t = transportFor({ P4: rejected });
  const report = await runProbe({ transport: t.fn, config, maxUsd: 0.1 });
  assert.equal(report.status, "stopped");
  assert.equal(report.findings.maxToolCalls, "value 1 rejected");
  assert.equal(
    report.results.find((r) => r.id === "P4").error.param,
    "max_tool_calls",
  );
  assert.ok(!ids(t.requests).includes("P5"));
});

test("max_tool_calls not respected: flagged and the probe stops before more searches", async () => {
  const t = transportFor({
    P4: responseOf({
      text: "x",
      searches: 3,
      sources: SOURCES,
      usage: USAGE_SEARCH,
    }),
  });
  const report = await runProbe({ transport: t.fn, config, maxUsd: 0.1 });
  assert.equal(report.status, "stopped");
  assert.equal(
    report.findings.maxToolCalls,
    "exceeded (3 searches for a limit of 1)",
  );
  assert.equal(
    report.results.find((r) => r.id === "P4").costUsd,
    0.03115,
    "all three searches are counted",
  );
  assert.ok(!ids(t.requests).includes("P5"));
});

test("missing sources, missing reasoning tokens and search tokens not in input are reported", async () => {
  const noSources = responseOf({
    text: "x",
    searches: 1,
    sources: [],
    usage: { input: 80, cached: 0, output: 300, reasoning: 0 },
  });
  delete noSources.json.usage.output_tokens_details;
  const t = transportFor({ P4: noSources });
  const report = await runProbe({ transport: t.fn, config, maxUsd: 0.1 });
  const p4 = report.results.find((r) => r.id === "P4");
  assert.equal(p4.verdict, "partial");
  const failed = p4.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed, [
    "reasoning tokens reported within output tokens",
    "sources reported",
    "search content counted in input tokens",
  ]);
  assert.equal(report.findings.sourcesReported, false);
  assert.equal(report.findings.searchTokensInInput, false);
  assert.equal(report.findings.reasoningTokensReported, false);
  assert.ok(report.recommendations.some((r) => r.includes("input_tokens")));
});

test("a spending-limit error stops immediately without retry", async () => {
  const t = transportFor({
    P3: errorOf(
      429,
      "project_spend_limit_exceeded",
      "Your project reached its enforced spend limit.",
    ),
  });
  const report = await runProbe({ transport: t.fn, config, maxUsd: 0.1 });
  assert.equal(report.status, "stopped");
  assert.match(report.stopReason, /QUOTA/);
  assert.deepEqual(ids(t.requests), ["P1", "P2", "P3"]);
});

test("server errors and timeouts stop the probe; a timeout counts its worst case", async () => {
  const server = await runProbe({
    transport: transportFor({ P2: errorOf(500, "server_error") }).fn,
    config,
    maxUsd: 0.1,
  });
  assert.equal(server.status, "stopped");
  assert.match(server.stopReason, /SERVER/);

  const timeout = Object.assign(new Error("No response within 120000 ms"), {
    kind: "TIMEOUT",
  });
  const t = transportFor({ P4: timeout });
  const report = await runProbe({ transport: t.fn, config, maxUsd: 0.1 });
  assert.equal(report.status, "stopped");
  assert.equal(
    report.totals.unknownChargesUsd,
    probeWorstCaseUsd(probePlan(config)[2], config),
  );
});

test("incomplete responses are recorded as partial, with usage still priced", async () => {
  const incomplete = responseOf({
    model: "gpt-6.1-sol",
    text: '{"ans',
    status: "incomplete",
    incompleteReason: "max_output_tokens",
    usage: { input: 60, cached: 0, output: 1000, reasoning: 1000 },
  });
  const report = await runProbe({
    transport: transportFor({ P3: incomplete }).fn,
    config,
    maxUsd: 0.1,
  });
  const p3 = report.results.find((r) => r.id === "P3");
  assert.equal(p3.verdict, "partial");
  assert.equal(p3.incompleteReason, "max_output_tokens");
  assert.equal(p3.costUsd, 0.01012);
  assert.equal(report.findings.solStructuredOutput, false);
});

test("store:false not honoured is flagged", async () => {
  const report = await runProbe({
    transport: transportFor({
      P6: { status: 200, headers: {}, json: { id: "resp_P2" } },
    }).fn,
    config,
    maxUsd: 0.1,
  });
  assert.equal(report.findings.storeFalseHonoured, false);
  assert.ok(report.recommendations.some((r) => r.includes("store:false")));
});

test("the authorized maximum is enforced before anything is sent", async () => {
  for (const maxUsd of [0.05, 0, -1, 0.11, Number.NaN]) {
    const t = transportFor();
    const report = await runProbe({ transport: t.fn, config, maxUsd });
    assert.equal(report.status, "blocked", String(maxUsd));
    assert.equal(t.requests.length, 0);
  }
});

test("reports never contain credentials or headers", async () => {
  const t = transportFor();
  const report = await runProbe({ transport: t.fn, config, maxUsd: 0.1 });
  const text = JSON.stringify(report).toLowerCase();
  for (const word of ["authorization", "bearer", "api_key", "apikey"])
    assert.ok(!text.includes(word), word);
});

test("CLI guards: --paid, --max-usd cap, output location and key are required before any call", () => {
  const cli = fileURLToPath(new URL("../probe.mjs", import.meta.url));
  const runCli = (args) => {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    try {
      execFileSync(process.execPath, [cli, ...args], {
        encoding: "utf8",
        env,
        stdio: "pipe",
      });
      return { status: 0, stderr: "" };
    } catch (error) {
      return { status: error.status, stderr: error.stderr };
    }
  };
  const src = fileURLToPath(new URL("../../../src/", import.meta.url));
  const cases = [
    [["--max-usd", "0.10", "--out", tmpdir()], /without --paid/],
    [["--paid", "--max-usd", "0.50", "--out", tmpdir()], /at most 0.1/],
    [["--paid", "--max-usd", "0.10", "--out", src], /must not be inside src/],
    [
      ["--paid", "--max-usd", "0.10", "--out", tmpdir()],
      /OPENAI_API_KEY is not set/,
    ],
    [["--paid", "--out", tmpdir()], /Usage/],
  ];
  for (const [args, message] of cases) {
    const r = runCli(args);
    assert.equal(r.status, 4, args.join(" "));
    assert.match(r.stderr, message);
  }
});
