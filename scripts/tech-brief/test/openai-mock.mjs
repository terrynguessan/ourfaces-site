// Builders for mocked OpenAI Responses API traffic. The shapes follow the
// documented response object: output items of type web_search_call (with
// action.sources when requested), reasoning and message (output_text with
// url_citation annotations, or refusal), plus a usage object. Nothing here
// talks to the network.

let counter = 0;
const id = (prefix) => `${prefix}_${(++counter).toString(16).padStart(8, "0")}`;

export const USAGE = {
  discovery: {
    input: 45_000,
    cached: 0,
    output: 6_000,
    reasoning: 4_000,
    searches: 4,
  },
  discoveryConversion: {
    input: 3_000,
    cached: 0,
    output: 1_500,
    reasoning: 800,
    searches: 0,
  },
  extraction: {
    input: 6_000,
    cached: 0,
    output: 1_200,
    reasoning: 500,
    searches: 0,
  },
  coreClaim: {
    input: 5_000,
    cached: 0,
    output: 600,
    reasoning: 300,
    searches: 0,
  },
  reverification: {
    input: 1_500,
    cached: 0,
    output: 400,
    reasoning: 0,
    searches: 0,
  },
  verification: {
    input: 9_000,
    cached: 0,
    output: 2_500,
    reasoning: 1_500,
    searches: 0,
  },
  writing: {
    input: 4_000,
    cached: 0,
    output: 9_000,
    reasoning: 6_000,
    searches: 0,
  },
  repair: {
    input: 3_000,
    cached: 0,
    output: 4_000,
    reasoning: 2_500,
    searches: 0,
  },
  review: {
    input: 6_000,
    cached: 0,
    output: 2_000,
    reasoning: 1_200,
    searches: 0,
  },
};

/** A completed response. `json` becomes the output text; sources/citations are URLs. */
export function responseOf({
  model = "gpt-6-luna",
  json,
  text,
  sources = [],
  citations = [],
  usage,
  searches = 0,
  // Optional explicit web_search_call actions, e.g. [{ type: "search" },
  // { type: "open_page", url }]. Overrides `searches`. Sources are attached
  // to the first search action.
  actions,
  status = "completed",
  incompleteReason,
  refusal,
}) {
  const output = [];
  const list =
    actions ?? Array.from({ length: searches }, () => ({ type: "search" }));
  let sourcesAttached = false;
  list.forEach((a, i) => {
    const action = { ...a };
    if (a.type === "search") {
      action.query = a.query ?? `query ${i + 1}`;
      action.sources = sourcesAttached
        ? []
        : sources.map((url) => ({ type: "url", url }));
      sourcesAttached = true;
    }
    output.push({
      id: id("ws"),
      type: "web_search_call",
      status: "completed",
      action,
    });
  });
  output.push({ id: id("rs"), type: "reasoning", summary: [] });
  const body = text ?? (json === undefined ? "" : JSON.stringify(json));
  output.push({
    id: id("msg"),
    type: "message",
    role: "assistant",
    status: status === "completed" ? "completed" : "incomplete",
    content: refusal
      ? [{ type: "refusal", refusal }]
      : [
          {
            type: "output_text",
            text: body,
            annotations: citations.map((url, i) => ({
              type: "url_citation",
              url,
              title: `Source ${i + 1}`,
              start_index: 0,
              end_index: 1,
            })),
          },
        ],
  });
  const u = usage ?? { input: 1000, cached: 0, output: 500, reasoning: 0 };
  return {
    status: 200,
    headers: {},
    json: {
      id: id("resp"),
      object: "response",
      status,
      incomplete_details: incompleteReason
        ? { reason: incompleteReason }
        : null,
      model,
      output,
      usage:
        usage === null
          ? undefined
          : {
              input_tokens: u.input,
              input_tokens_details: { cached_tokens: u.cached },
              output_tokens: u.output,
              output_tokens_details: { reasoning_tokens: u.reasoning },
              total_tokens: u.input + u.output,
            },
    },
  };
}

/** An HTTP error response in the documented error envelope. */
export function errorOf(status, code, message = "error", headers = {}) {
  return {
    status,
    headers,
    json: {
      error: {
        message,
        type: status === 429 ? "insufficient_quota" : "server_error",
        code,
      },
    },
  };
}

export function rateLimitOf(retryAfterSeconds) {
  return {
    status: 429,
    headers: { "retry-after": String(retryAfterSeconds) },
    json: {
      error: {
        message: "Rate limit reached",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    },
  };
}

/** Reads the TASK DATA JSON line that every prompt starts with. */
export function taskData(body) {
  const lines = String(body.input).split("\n");
  return JSON.parse(lines[lines.indexOf("TASK DATA:") + 1]);
}

/** Lines of the untrusted block, without markers. */
export function untrustedLines(body) {
  const lines = String(body.input).split("\n");
  const start = lines.findIndex((l) => l.startsWith("UNTRUSTED BEGIN "));
  const end = lines.findIndex((l) => l.startsWith("UNTRUSTED END "));
  return start >= 0 && end > start ? lines.slice(start + 1, end) : [];
}

/** Stage name of a request body (schema name, or plain discovery when tools are present). */
export function stageOf(body) {
  return (
    body.text?.format?.name ?? (body.tools ? "discovery-plain" : "unknown")
  );
}
