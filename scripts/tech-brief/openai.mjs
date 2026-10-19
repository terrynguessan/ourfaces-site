// Minimal OpenAI Responses API client for the Tech Brief (no SDK).
//
// - Requests go only to the configured API base URL; the key is read by the
//   caller from OPENAI_API_KEY and never appears in errors, logs or reports.
// - Every response is stored nowhere (store: false) and requested on the
//   standard service tier. No automatic Flex, no model substitution.
// - A cost meter prices each call from the response's usage data and counted
//   web_search_call items, and refuses a call whose worst-case cost would push
//   the run over its ceiling. These are software estimates, not billing
//   guarantees; the provider-side hard limit is the backstop.
// - Structured outputs are requested in strict mode and validated again locally.

import { SCHEMAS, validateAgainstSchema } from "./schemas.mjs";

export class OpenAIError extends Error {
  /** kind: QUOTA | BUDGET | RATE_LIMIT | SERVER | TIMEOUT | NETWORK | BAD_REQUEST | AUTH | INCOMPLETE | REFUSAL | INVALID_OUTPUT */
  constructor(kind, message, details = {}) {
    super(message);
    this.kind = kind;
    this.details = details;
  }
}

const RETRYABLE = new Set(["RATE_LIMIT", "SERVER", "TIMEOUT", "NETWORK"]);
// 429 codes that mean money or quota is exhausted; retrying cannot help.
const QUOTA_CODES = new Set([
  "project_spend_limit_exceeded",
  "organization_spend_limit_exceeded",
  "credit_balance_exhausted",
  "organization_usage_limit_exceeded",
  "insufficient_quota",
]);

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Tracks estimated spend for one run.
 * - billed estimate: tokens plus billable search actions, from usage data
 * - unknown charges: amounts that may have been billed but cannot be known
 *   (timed-out calls, missing usage, non-search web actions); counted at
 *   their conservative value so the ceiling check stays on the safe side
 * - overruns: calls whose counted cost exceeded their pre-call worst case
 */
export function createMeter({ prices, perRunUsd, retriesPerRun }) {
  const calls = [];
  const overruns = [];
  let spent = 0;
  let unknown = 0;
  let retriesLeft = retriesPerRun;
  return {
    calls,
    overruns,
    get spentUsd() {
      return round6(spent + unknown);
    },
    get billedEstimateUsd() {
      return round6(spent);
    },
    get unknownChargesUsd() {
      return round6(unknown);
    },
    get retriesLeft() {
      return retriesLeft;
    },
    useRetry() {
      if (retriesLeft <= 0) return false;
      retriesLeft--;
      return true;
    },
    /** Throws BUDGET if the worst case of the next call could exceed the per-run ceiling. */
    ensureCanSpend(stage, worstCaseUsd) {
      if (spent + unknown + worstCaseUsd > perRunUsd) {
        throw new OpenAIError(
          "BUDGET",
          `Run ceiling $${perRunUsd} would be exceeded by ${stage} (spent $${round6(spent + unknown)}, worst case $${round6(worstCaseUsd)})`,
        );
      }
    },
    price(model, usage, searches) {
      const p = prices.models[model];
      if (!p)
        throw new OpenAIError(
          "BAD_REQUEST",
          `No price configured for model ${model}`,
        );
      const input = usage?.input_tokens ?? 0;
      const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
      const output = usage?.output_tokens ?? 0; // includes reasoning tokens
      return round6(
        ((input - cached) * p.inputPerMTokUsd +
          cached * p.cachedInputPerMTokUsd +
          output * p.outputPerMTokUsd) /
          1e6 +
          searches * prices.webSearchPerCallUsd,
      );
    },
    record(entry) {
      calls.push(entry);
      spent += entry.costUsd ?? 0;
      unknown += entry.unknownChargeUsd ?? 0;
    },
  };
}

/**
 * Maximum number of web_search_call items a request is budgeted for: its
 * max_tool_calls plus an allowance for page-open / find-in-page actions. The
 * dry run (run-26e47111) returned limit + 1 items, so the limit alone is not
 * a safe bound on items.
 */
export function toolItemBudget(request, { estimates }) {
  return request.maxToolCalls + estimates.extraToolActionsAllowance;
}

/**
 * Worst-case cost of a request before it is sent. Output is hard-capped by
 * max_output_tokens. Web search is bounded by the item budget above, each
 * item priced as a billable search plus a conservative amount of search
 * content. A web search request without max_tool_calls cannot be bounded and
 * is refused.
 */
export function worstCaseUsd(request, { prices, estimates }) {
  const p = prices.models[request.model];
  if (!p)
    throw new OpenAIError(
      "BAD_REQUEST",
      `No price configured for model ${request.model}`,
    );
  const searching = request.tools?.some((t) => t.type === "web_search");
  if (
    searching &&
    !(Number.isInteger(request.maxToolCalls) && request.maxToolCalls >= 1)
  ) {
    throw new OpenAIError(
      "BUDGET",
      "A web_search request without a positive max_tool_calls cannot be cost-bounded",
    );
  }
  const items = searching ? toolItemBudget(request, { estimates }) : 0;
  const promptTokens = Math.ceil(
    ((request.instructions ?? "").length + (request.input ?? "").length) /
      estimates.charsPerToken,
  );
  const inputTokens =
    promptTokens + items * estimates.searchContentTokensPerItemWorstCase;
  return round6(
    (inputTokens * p.inputPerMTokUsd +
      request.maxOutputTokens * p.outputPerMTokUsd) /
      1e6 +
      items * prices.webSearchPerCallUsd,
  );
}

/** Default transport: HTTPS POST/GET with Node's built-in fetch and a hard timeout. */
export function fetchTransport({ apiKey, baseUrl }) {
  if (!apiKey) throw new OpenAIError("AUTH", "OPENAI_API_KEY is not set");
  const origin = new URL(baseUrl);
  if (origin.protocol !== "https:")
    throw new OpenAIError("BAD_REQUEST", "API base URL must be https");
  return async ({ method = "POST", path, body, timeoutMs }) => {
    let response;
    try {
      response = await fetch(
        new URL(`${origin.pathname.replace(/\/$/, "")}${path}`, origin),
        {
          method,
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        },
      );
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError")
        throw new OpenAIError("TIMEOUT", `No response within ${timeoutMs} ms`);
      throw new OpenAIError(
        "NETWORK",
        `Request failed: ${error.cause?.code ?? error.name}`,
      );
    }
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return {
      status: response.status,
      headers: { "retry-after": response.headers.get("retry-after") },
      json,
    };
  };
}

/** Maps an HTTP error response to an OpenAIError kind. */
export function classifyHttpError(status, json) {
  const code = json?.error?.code ?? json?.error?.type ?? "";
  const message = String(json?.error?.message ?? `HTTP ${status}`).slice(
    0,
    300,
  );
  if (
    status === 429 &&
    (QUOTA_CODES.has(code) || json?.error?.type === "insufficient_quota")
  )
    return new OpenAIError("QUOTA", message, { status, code });
  if (status === 429)
    return new OpenAIError("RATE_LIMIT", message, { status, code });
  if (status === 401 || status === 403)
    return new OpenAIError("AUTH", message, { status, code });
  if (status >= 500)
    return new OpenAIError("SERVER", message, { status, code });
  if (status === 408)
    return new OpenAIError("TIMEOUT", message, { status, code });
  return new OpenAIError("BAD_REQUEST", message, { status, code });
}

// web_search_call action types that are not searches. The web search guide
// says "Search actions incur a tool call cost" and lists open_page and
// find_in_page as separate actions; "find" is accepted as an alias. Any other
// or missing type is treated as a billable search (conservative).
const NON_SEARCH_ACTIONS = new Set(["open_page", "find_in_page", "find"]);

/**
 * Extracts text, refusals, web search actions, sources and citations from a
 * response. Only URLs and short queries are kept from actions, never page
 * content.
 */
export function parseResponse(json) {
  const output = Array.isArray(json?.output) ? json.output : [];
  const searches = output.filter((item) => item?.type === "web_search_call");
  const sources = [];
  for (const call of searches)
    for (const s of call.action?.sources ?? [])
      if (typeof s?.url === "string") sources.push(s.url);
  const actions = searches.map((call) => {
    const action = call.action ?? {};
    const type = typeof action.type === "string" ? action.type : "unknown";
    const queries = [
      ...(typeof action.query === "string" ? [action.query] : []),
      ...(Array.isArray(action.queries)
        ? action.queries.filter((q) => typeof q === "string")
        : []),
    ].map((q) => q.slice(0, 200));
    return {
      type,
      billable: !NON_SEARCH_ACTIONS.has(type),
      status: typeof call.status === "string" ? call.status : null,
      queries: queries.slice(0, 5),
      url: typeof action.url === "string" ? action.url.slice(0, 2048) : null,
      sources: Array.isArray(action.sources) ? action.sources.length : 0,
    };
  });
  const actionUrls = actions.map((a) => a.url).filter(Boolean);
  const texts = [];
  const citations = [];
  let refusal = null;
  for (const item of output) {
    if (item?.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part?.type === "output_text") {
        texts.push(String(part.text ?? ""));
        for (const a of part.annotations ?? [])
          if (a?.type === "url_citation" && typeof a.url === "string")
            citations.push(a.url);
      } else if (part?.type === "refusal") {
        refusal = String(part.refusal ?? "refused");
      }
    }
  }
  return {
    status: json?.status ?? "unknown",
    incompleteReason: json?.incomplete_details?.reason ?? null,
    text: texts.join(""),
    refusal,
    searchCount: searches.length,
    billableSearchCount: actions.filter((a) => a.billable).length,
    otherActionCount: actions.filter((a) => !a.billable).length,
    actions,
    actionUrls,
    sources,
    citations,
    usage: json?.usage ?? null,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates a client. `transport` is injected in tests; production uses
 * fetchTransport. `meter` enforces the per-run ceiling.
 */
export function createClient({ transport, config, meter, wait = sleep }) {
  const timeoutMs = config.limits.requestTimeoutMs;

  function buildBody(request) {
    const body = {
      model: request.model,
      instructions: request.instructions,
      input: request.input,
      store: false,
      service_tier: config.serviceTier,
      reasoning: { effort: request.reasoningEffort },
      max_output_tokens: request.maxOutputTokens,
    };
    if (request.schemaName) {
      body.text = {
        format: {
          type: "json_schema",
          name: request.schemaName,
          schema: SCHEMAS[request.schemaName],
          strict: true,
        },
      };
    }
    if (request.tools) {
      body.tools = request.tools;
      body.tool_choice = request.toolChoice ?? "auto";
      if (request.maxToolCalls !== undefined)
        body.max_tool_calls = request.maxToolCalls;
      if (request.include) body.include = request.include;
    }
    return body;
  }

  /**
   * Sends one stage request. Returns { json (parsed structured output or null),
   * text, sources, citations, searchCount, costUsd }. Throws OpenAIError.
   */
  async function respond(stage, request) {
    const worst = worstCaseUsd(request, config);
    const body = buildBody(request);
    for (let attempt = 1; ; attempt++) {
      meter.ensureCanSpend(stage, worst);
      const started = Date.now();
      const entry = {
        stage,
        model: request.model,
        attempt,
        worstCaseUsd: worst,
      };
      let result;
      try {
        result = await transport({
          method: "POST",
          path: "/responses",
          body,
          timeoutMs,
        });
      } catch (error) {
        const err =
          error instanceof OpenAIError
            ? error
            : new OpenAIError("NETWORK", "Transport failed");
        // The request may have been processed: count its worst case as an unknown charge.
        meter.record({
          ...entry,
          status: err.kind,
          durationMs: Date.now() - started,
          costUsd: 0,
          unknownChargeUsd: worst,
        });
        if (
          RETRYABLE.has(err.kind) &&
          attempt <= config.limits.retriesPerCall &&
          meter.useRetry()
        ) {
          await wait(1000 * attempt);
          continue;
        }
        throw err;
      }

      if (result.status !== 200) {
        const err = classifyHttpError(result.status, result.json);
        meter.record({
          ...entry,
          status: err.kind,
          httpStatus: result.status,
          code: err.details.code,
          durationMs: Date.now() - started,
          costUsd: 0,
        });
        if (
          RETRYABLE.has(err.kind) &&
          attempt <= config.limits.retriesPerCall &&
          meter.useRetry()
        ) {
          const retryAfter = Number(result.headers?.["retry-after"]);
          await wait(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter, 60) * 1000
              : 2000 * attempt,
          );
          continue;
        }
        throw err;
      }

      const parsed = parseResponse(result.json);
      // Billed estimate: tokens plus billable search actions only.
      const costUsd = meter.price(
        request.model,
        parsed.usage,
        parsed.billableSearchCount,
      );
      // Non-search web actions are not documented as billed; count them at
      // the search price anyway so the ceiling check stays conservative.
      const actionAllowanceUsd = round6(
        parsed.otherActionCount * config.prices.webSearchPerCallUsd,
      );
      const usage = parsed.usage ?? {};
      meter.record({
        ...entry,
        status: parsed.status,
        durationMs: Date.now() - started,
        inputTokens: usage.input_tokens ?? 0,
        cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
        searches: parsed.billableSearchCount,
        otherActions: parsed.otherActionCount,
        toolItems: parsed.searchCount,
        searchLimit: request.maxToolCalls ?? null,
        costUsd,
        unknownChargeUsd: actionAllowanceUsd,
        ...(parsed.usage ? {} : { usageMissing: true }),
      });
      if (!parsed.usage) {
        // Without usage data the cost is unknown: count the worst case.
        meter.record({
          stage,
          model: request.model,
          attempt,
          status: "usage-missing",
          costUsd: 0,
          unknownChargeUsd: worst,
        });
      }
      // Overrun detection: the counted cost of this call, or its number of
      // web search items, exceeded what the pre-call estimate allowed. The
      // estimate can no longer be trusted, so the run must stop.
      const counted = round6(costUsd + actionAllowanceUsd);
      const itemLimit = request.tools?.some((t) => t.type === "web_search")
        ? toolItemBudget(request, config)
        : 0;
      if (counted > worst || parsed.searchCount > itemLimit) {
        const overrun = {
          stage,
          model: request.model,
          worstCaseUsd: worst,
          countedUsd: counted,
          toolItems: parsed.searchCount,
          toolItemBudget: itemLimit,
        };
        meter.overruns.push(overrun);
        throw new OpenAIError(
          "BUDGET",
          `Estimate overrun in ${stage}: counted $${counted} (${parsed.searchCount} web search items) against a worst case of $${worst} (${itemLimit} items)`,
          { overrun },
        );
      }
      if (parsed.status === "incomplete")
        throw new OpenAIError(
          "INCOMPLETE",
          `Response incomplete: ${parsed.incompleteReason ?? "unknown reason"}`,
        );
      if (parsed.status !== "completed")
        throw new OpenAIError(
          "SERVER",
          `Unexpected response status ${parsed.status}`,
        );
      if (parsed.refusal)
        throw new OpenAIError("REFUSAL", "The model refused the request");
      let json = null;
      if (request.schemaName) {
        // The raw (untrusted) output travels with the error so a caller can
        // fall back without paying for the same call again.
        const raw = {
          text: parsed.text,
          sources: parsed.sources,
          citations: parsed.citations,
          actions: parsed.actions,
          actionUrls: parsed.actionUrls,
        };
        try {
          json = JSON.parse(parsed.text);
        } catch {
          throw new OpenAIError(
            "INVALID_OUTPUT",
            "Structured output is not valid JSON",
            raw,
          );
        }
        const problems = validateAgainstSchema(
          json,
          SCHEMAS[request.schemaName],
        );
        if (problems.length)
          throw new OpenAIError(
            "INVALID_OUTPUT",
            `Structured output violates schema: ${problems.slice(0, 3).join("; ")}`,
            raw,
          );
      }
      return {
        json,
        text: parsed.text,
        sources: parsed.sources,
        citations: parsed.citations,
        actions: parsed.actions,
        actionUrls: parsed.actionUrls,
        searchCount: parsed.searchCount,
        billableSearchCount: parsed.billableSearchCount,
        otherActionCount: parsed.otherActionCount,
        costUsd,
      };
    }
  }

  /** Lists model IDs available to the key (GET /v1/models, not billed). */
  async function listModels() {
    const result = await transport({
      method: "GET",
      path: "/models",
      timeoutMs,
    });
    if (result.status !== 200)
      throw classifyHttpError(result.status, result.json);
    return (result.json?.data ?? []).map((m) => m.id);
  }

  return { respond, listModels, buildBody };
}
