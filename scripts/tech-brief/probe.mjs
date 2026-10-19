// OpenAI API capability probe for the Tech Brief (paid; run only when authorized).
//
// Verifies, with the smallest possible requests, the API behaviour that
// research.mjs assumes but that the documentation does not settle:
//   P1 models      GET /models lists gpt-6-luna and gpt-6.1-sol (free)
//   P2 luna        strict JSON schema output on gpt-6-luna; usage and reasoning tokens
//   P3 sol         strict JSON schema output on gpt-6.1-sol; usage and reasoning tokens
//   P4 search      web_search with max_tool_calls 1 (no schema): availability,
//                  max_tool_calls accepted and respected, sources reported,
//                  search content reflected in input tokens
//   P5 search+json web_search combined with strict json_schema output
//   P6 store       GET /responses/{id} of P2 returns 404 because store:false (free)
//
// Safety:
// - Paid requests need --paid and --max-usd (at most $0.10) and OPENAI_API_KEY.
// - Before anything is sent, the summed worst case of every paid request must
//   fit under --max-usd; before each request, spent + that request's worst case
//   must still fit. Worst cases assume a full 128k-token search context.
// - No retries. Quota, auth, server and unexpected errors stop the probe.
// - The key is only used by the transport; reports never contain headers.
// - Writes a JSON report to --out (never inside src/); changes nothing else.

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  classifyHttpError,
  createMeter,
  fetchTransport,
  parseResponse,
} from "./openai.mjs";
import { loadConfig } from "./research.mjs";

export const PROBE_MAX_USD = 0.1;
// Documented cap on web search context in the Responses API.
const MAX_SEARCH_CONTEXT_TOKENS = 128_000;

const answerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string", enum: ["ok"] } },
};
const sourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["url", "title"],
  properties: { url: { type: "string" }, title: { type: "string" } },
};

const SEARCH_TASK =
  "Use web search to find the official Node.js release schedule page and, in a separate search, the official Python release schedule page. Report one page you found.";

/** The paid requests, in order. Bodies mirror research.mjs requests. */
export function probePlan(config) {
  const luna = config.stages.discovery.model;
  const sol = config.stages.verification.model;
  const base = (model, maxOutputTokens) => ({
    model,
    store: false,
    service_tier: config.serviceTier,
    reasoning: { effort: "low" },
    max_output_tokens: maxOutputTokens,
  });
  const json = (name, schema) => ({
    text: { format: { type: "json_schema", name, schema, strict: true } },
  });
  const search = {
    tools: [{ type: "web_search", search_context_size: "low" }],
    tool_choice: "required",
    max_tool_calls: 1,
    include: ["web_search_call.action.sources"],
  };
  return [
    {
      id: "P2",
      purpose: `${luna}: strict structured output, usage and reasoning tokens`,
      maxSearches: 0,
      body: {
        ...base(luna, 1000),
        instructions: "Reply with the JSON object requested.",
        input: 'Return {"answer":"ok"}.',
        ...json("probe_answer", answerSchema),
      },
    },
    {
      id: "P3",
      purpose: `${sol}: strict structured output, usage and reasoning tokens`,
      maxSearches: 0,
      body: {
        ...base(sol, 1000),
        instructions: "Reply with the JSON object requested.",
        input: 'Return {"answer":"ok"}.',
        ...json("probe_answer", answerSchema),
      },
    },
    {
      id: "P4",
      purpose: `${luna}: web_search with max_tool_calls 1, sources, usage`,
      maxSearches: 1,
      body: {
        ...base(luna, 2000),
        instructions: "Answer in one short sentence.",
        input: SEARCH_TASK,
        ...search,
      },
    },
    {
      id: "P5",
      purpose: `${luna}: web_search combined with strict json_schema`,
      maxSearches: 1,
      body: {
        ...base(luna, 2000),
        instructions: "Reply with the JSON object requested.",
        input: SEARCH_TASK,
        ...search,
        ...json("probe_source", sourceSchema),
      },
    },
  ];
}

/** Worst-case cost of one planned request (full search context, full output). */
export function probeWorstCaseUsd(step, config) {
  const p = config.prices.models[step.body.model];
  if (!p) throw new Error(`No price configured for ${step.body.model}`);
  const promptTokens = Math.ceil(
    (step.body.instructions.length +
      step.body.input.length +
      JSON.stringify(step.body.text ?? {}).length) /
      config.estimates.charsPerToken,
  );
  const input = promptTokens + step.maxSearches * MAX_SEARCH_CONTEXT_TOKENS;
  return (
    Math.round(
      ((input * p.inputPerMTokUsd +
        step.body.max_output_tokens * p.outputPerMTokUsd) /
        1e6 +
        step.maxSearches * config.prices.webSearchPerCallUsd) *
        1e6,
    ) / 1e6
  );
}

const truncate = (s, n) =>
  typeof s === "string" && s.length > n ? `${s.slice(0, n)}...` : s;

/**
 * Runs the probe with an injected transport. Returns the report object;
 * never throws for API errors.
 */
export async function runProbe({ transport, config, maxUsd }) {
  const plan = probePlan(config);
  const report = {
    schema: "ourfaces-tech-brief-probe-report/1",
    startedAt: new Date().toISOString(),
    maxUsd,
    plannedWorstCaseUsd: null,
    status: null,
    stopReason: null,
    results: [],
    findings: {},
    recommendations: [],
    totals: null,
  };
  const meter = createMeter({
    prices: config.prices,
    perRunUsd: maxUsd,
    retriesPerRun: 0,
  });
  const finish = (status, stopReason = null) => {
    report.status = status;
    report.stopReason = stopReason;
    report.finishedAt = new Date().toISOString();
    report.totals = {
      estimatedBilledUsd: meter.billedEstimateUsd,
      unknownChargesUsd: meter.unknownChargesUsd,
      countedUsd: meter.spentUsd,
      note: "Estimated from usage data and documented prices; compare with the OpenAI usage dashboard.",
    };
    return report;
  };

  // Preflight: the whole plan must fit the authorized maximum before anything is sent.
  if (!(typeof maxUsd === "number" && maxUsd > 0 && maxUsd <= PROBE_MAX_USD))
    return finish(
      "blocked",
      `--max-usd must be greater than 0 and at most ${PROBE_MAX_USD}`,
    );
  const worst = plan.map((step) => ({
    id: step.id,
    worstCaseUsd: probeWorstCaseUsd(step, config),
  }));
  report.plannedWorstCaseUsd =
    Math.round(worst.reduce((sum, w) => sum + w.worstCaseUsd, 0) * 1e6) / 1e6;
  report.plannedSteps = worst;
  if (report.plannedWorstCaseUsd > maxUsd)
    return finish(
      "blocked",
      `Planned worst case $${report.plannedWorstCaseUsd} exceeds the authorized $${maxUsd}`,
    );

  const call = async (request) => {
    try {
      return await transport(request);
    } catch (error) {
      return {
        transportError: error.kind ?? "NETWORK",
        message: error.message,
      };
    }
  };

  // P1: model availability (GET, not billed).
  const models = await call({
    method: "GET",
    path: "/models",
    timeoutMs: 30_000,
  });
  const p1 = {
    id: "P1",
    purpose: "configured models are available to this key",
    httpStatus: models.status ?? null,
  };
  report.results.push(p1);
  if (models.transportError || models.status !== 200) {
    const err = models.transportError
      ? { kind: models.transportError, message: models.message }
      : classifyHttpError(models.status, models.json);
    Object.assign(p1, {
      verdict: "fail",
      error: {
        kind: err.kind,
        code: err.details?.code ?? null,
        message: truncate(err.message, 300),
      },
    });
    return finish("stopped", `P1 failed: ${err.kind}`);
  }
  const ids = new Set((models.json?.data ?? []).map((m) => m.id));
  const wanted = [...new Set(Object.values(config.stages).map((s) => s.model))];
  p1.available = Object.fromEntries(wanted.map((m) => [m, ids.has(m)]));
  p1.verdict = wanted.every((m) => ids.has(m)) ? "pass" : "fail";
  report.findings.modelsAvailable = p1.available;
  if (p1.verdict !== "pass")
    return finish(
      "stopped",
      "A configured model is not available; no paid request was sent and no substitute is used",
    );

  let storedId = null;
  for (const step of plan) {
    const stepWorst = worst.find((w) => w.id === step.id).worstCaseUsd;
    const result = {
      id: step.id,
      purpose: step.purpose,
      model: step.body.model,
      request: summarize(step.body),
      worstCaseUsd: stepWorst,
    };
    report.results.push(result);
    try {
      meter.ensureCanSpend(step.id, stepWorst);
    } catch (error) {
      result.verdict = "not-run";
      return finish("stopped", error.message);
    }

    const response = await call({
      method: "POST",
      path: "/responses",
      body: step.body,
      timeoutMs: config.limits.requestTimeoutMs,
    });
    if (response.transportError) {
      meter.record({
        stage: step.id,
        model: step.body.model,
        status: response.transportError,
        costUsd: 0,
        unknownChargeUsd: stepWorst,
      });
      Object.assign(result, {
        verdict: "fail",
        error: {
          kind: response.transportError,
          message: truncate(response.message, 300),
        },
      });
      return finish(
        "stopped",
        `${step.id}: ${response.transportError} (worst case counted as unknown charge)`,
      );
    }
    result.httpStatus = response.status;
    if (response.status !== 200) {
      const err = classifyHttpError(response.status, response.json);
      meter.record({
        stage: step.id,
        model: step.body.model,
        status: err.kind,
        costUsd: 0,
      });
      result.error = {
        kind: err.kind,
        code: err.details.code ?? null,
        param: response.json?.error?.param ?? null,
        message: truncate(err.message, 300),
      };
      result.verdict = "fail";
      // An expected kind of rejection: record it and decide how to continue.
      if (err.kind === "BAD_REQUEST" && step.id === "P5") {
        report.findings.webSearchWithStrictSchema = "rejected";
        continue;
      }
      if (err.kind === "BAD_REQUEST" && step.id === "P4") {
        const aboutLimit =
          result.error.param === "max_tool_calls" ||
          /max_tool_calls/i.test(result.error.message ?? "");
        report.findings.maxToolCalls = aboutLimit
          ? "value 1 rejected"
          : "unclear rejection";
        return finish(
          "stopped",
          `P4 rejected (${aboutLimit ? "max_tool_calls" : "bad request"}); web search probes stopped to avoid unbounded searches`,
        );
      }
      return finish(
        "stopped",
        `${step.id}: ${err.kind}${err.kind === "QUOTA" ? " (spending or quota limit; nothing retried)" : ""}`,
      );
    }

    const parsed = parseResponse(response.json);
    const usage = parsed.usage ?? null;
    const costUsd = usage
      ? meter.price(step.body.model, usage, parsed.searchCount)
      : 0;
    meter.record({
      stage: step.id,
      model: step.body.model,
      status: parsed.status,
      costUsd,
      ...(usage ? {} : { unknownChargeUsd: stepWorst }),
    });
    Object.assign(result, {
      responseStatus: parsed.status,
      incompleteReason: parsed.incompleteReason,
      storeEchoed: response.json?.store ?? null,
      searchCount: parsed.searchCount,
      sourcesReturned: parsed.sources.length,
      sampleSources: parsed.sources.slice(0, 3),
      citations: parsed.citations.length,
      outputText: truncate(parsed.text, 300),
      refusal: parsed.refusal,
      usage: usage
        ? {
            inputTokens: usage.input_tokens ?? null,
            cachedTokens: usage.input_tokens_details?.cached_tokens ?? null,
            outputTokens: usage.output_tokens ?? null,
            reasoningTokens:
              usage.output_tokens_details?.reasoning_tokens ?? null,
          }
        : null,
      costUsd,
    });
    const checks = [];
    const check = (name, ok) => checks.push({ name, ok });
    check("status completed", parsed.status === "completed");
    check("usage reported", Boolean(usage));
    check(
      "reasoning tokens reported within output tokens",
      typeof usage?.output_tokens_details?.reasoning_tokens === "number" &&
        usage.output_tokens_details.reasoning_tokens <= usage.output_tokens,
    );
    if (step.body.text) {
      let parsedJson = null;
      try {
        parsedJson = JSON.parse(parsed.text);
      } catch {
        parsedJson = null;
      }
      const keys =
        parsedJson && typeof parsedJson === "object"
          ? Object.keys(parsedJson).sort().join(",")
          : "";
      check(
        "strict JSON output matches schema keys",
        keys ===
          Object.keys(step.body.text.format.schema.properties).sort().join(","),
      );
    }
    if (step.maxSearches) {
      check("web search performed", parsed.searchCount >= 1);
      check(
        "max_tool_calls respected",
        parsed.searchCount <= step.body.max_tool_calls,
      );
      check("sources reported", parsed.sources.length > 0);
      // Search content should appear in input tokens: far above the prompt alone.
      const promptTokens = Math.ceil(
        (step.body.instructions.length + step.body.input.length) /
          config.estimates.charsPerToken,
      );
      check(
        "search content counted in input tokens",
        (usage?.input_tokens ?? 0) > promptTokens * 3,
      );
    }
    result.checks = checks;
    result.verdict = checks.every((c) => c.ok) ? "pass" : "partial";

    if (step.id === "P2") {
      storedId = response.json?.id ?? null;
      report.findings.lunaStructuredOutput = checks.every((c) => c.ok);
    }
    if (step.id === "P3")
      report.findings.solStructuredOutput = checks.every((c) => c.ok);
    if (step.id === "P4") {
      report.findings.webSearch = parsed.searchCount >= 1;
      report.findings.maxToolCalls =
        parsed.searchCount <= 1
          ? "accepted and respected"
          : `exceeded (${parsed.searchCount} searches for a limit of 1)`;
      report.findings.sourcesReported = parsed.sources.length > 0;
      report.findings.searchTokensInInput = checks.find(
        (c) => c.name === "search content counted in input tokens",
      ).ok;
      if (parsed.searchCount > 1)
        return finish(
          "stopped",
          "max_tool_calls was not respected; stopping before further searches",
        );
    }
    if (step.id === "P5")
      report.findings.webSearchWithStrictSchema =
        result.verdict === "pass"
          ? "supported"
          : "accepted but output not usable";
    report.findings.reasoningTokensReported =
      (report.findings.reasoningTokensReported ?? true) &&
      checks.find((c) => c.name.startsWith("reasoning")).ok;
  }

  // P6: store:false means the response cannot be retrieved later (GET, not billed).
  const p6 = { id: "P6", purpose: "store:false responses are not retrievable" };
  report.results.push(p6);
  if (storedId) {
    const retrieved = await call({
      method: "GET",
      path: `/responses/${encodeURIComponent(storedId)}`,
      timeoutMs: 30_000,
    });
    p6.httpStatus = retrieved.status ?? null;
    p6.verdict = retrieved.status === 404 ? "pass" : "fail";
    report.findings.storeFalseHonoured = retrieved.status === 404;
  } else {
    p6.verdict = "not-run";
  }

  // Configuration recommendations derived from the findings.
  const f = report.findings;
  if (f.webSearchWithStrictSchema === "supported")
    report.recommendations.push(
      'Keep stages.discovery.structuredOutputWithSearch = "auto" (or set true).',
    );
  if (
    f.webSearchWithStrictSchema &&
    f.webSearchWithStrictSchema !== "supported"
  )
    report.recommendations.push(
      "Set stages.discovery.structuredOutputWithSearch = false so discovery uses plain text plus the conversion call.",
    );
  if (f.maxToolCalls === "accepted and respected")
    report.recommendations.push(
      "max_tool_calls is a usable upper bound; keep stages.discovery.maxToolCalls at 5.",
    );
  if (f.searchTokensInInput === false)
    report.recommendations.push(
      "Search content did not appear in input_tokens; re-check how search content is billed before trusting cost estimates.",
    );
  if (f.storeFalseHonoured === false)
    report.recommendations.push(
      "Responses were retrievable despite store:false; investigate before any production use.",
    );
  return finish("completed");
}

/** Request summary for the report: never headers, never the key. */
function summarize(body) {
  return {
    model: body.model,
    reasoningEffort: body.reasoning?.effort,
    maxOutputTokens: body.max_output_tokens,
    store: body.store,
    serviceTier: body.service_tier,
    schema: body.text?.format?.name ?? null,
    strict: body.text?.format?.strict ?? null,
    tools: (body.tools ?? []).map((t) => t.type),
    maxToolCalls: body.max_tool_calls ?? null,
    include: body.include ?? [],
  };
}

// CLI: node scripts/tech-brief/probe.mjs --paid --max-usd 0.10 --out DIR
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const fail = (message) => {
    console.error(message);
    process.exit(4);
  };
  const out = option("--out");
  const maxUsd = Number(option("--max-usd"));
  if (!out || option("--max-usd") === undefined)
    fail("Usage: probe.mjs --paid --max-usd <=0.10 --out DIR");
  if (!args.includes("--paid"))
    fail("Refusing to call the OpenAI API without --paid");
  if (!(maxUsd > 0 && maxUsd <= PROBE_MAX_USD))
    fail(`--max-usd must be greater than 0 and at most ${PROBE_MAX_USD}`);
  const repoSrc = fileURLToPath(new URL("../../src/", import.meta.url));
  const outDir = resolve(out);
  const rel = relative(repoSrc, outDir);
  if (!rel.startsWith("..") && !isAbsolute(rel))
    fail("--out must not be inside src/");

  const config = await loadConfig();
  let transport;
  try {
    transport = fetchTransport({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: config.apiBaseUrl,
    });
  } catch (error) {
    fail(`Cannot start: ${error.kind ?? "ERROR"}: ${error.message}`);
  }
  const report = await runProbe({ transport, config, maxUsd });
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, "probe-report.json");
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        status: report.status,
        stopReason: report.stopReason,
        countedUsd: report.totals.countedUsd,
        findings: report.findings,
        report: file,
      },
      null,
      2,
    ),
  );
  process.exit(
    report.status === "completed" ? 0 : report.status === "blocked" ? 4 : 1,
  );
}
