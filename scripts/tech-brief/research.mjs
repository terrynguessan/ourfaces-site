// Phase 3: weekly research pipeline producing a Phase 1-compatible bilingual
// edition plus a machine-readable research and cost report.
//
// Stages: preflight -> discovery (web search) -> policy/duplicate filters ->
// secure fetch -> claim extraction and editorial classification (F5,
// editorial.mjs) -> claim verification against the original
// article -> independent corroboration -> ranking -> EN/FR writing ->
// deterministic checks (+ one repair pass) -> faithfulness review (+ at most
// one repair of rejected wording, checked and reviewed again) -> final
// validation with validate.mjs.
//
// Claim VERIFICATION means a claim is entailed by a verbatim quote from the
// story's own article. CORROBORATION means a different site independently
// reports the same event. They are recorded separately; corroboration never
// substitutes for verification.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EDITORIAL_POLICY,
  checkAttribution,
  classifyEditorial,
} from "./editorial.mjs";
import { createFetcher } from "./fetch.mjs";
import { buildEvidence } from "./html.mjs";
import {
  OpenAIError,
  createClient,
  createMeter,
  fetchTransport,
} from "./openai.mjs";
import {
  coreReextractionPrompt,
  discoveryConversionPrompt,
  discoveryPrompt,
  extractionPrompt,
  repairPrompt,
  reviewPrompt,
  verificationPrompt,
  writingPrompt,
} from "./prompts.mjs";
import { productionResearchBlock } from "./schedule.mjs";
import {
  cleanText,
  containsQuote,
  extractNumbers,
  guessLanguage,
  normalizeForMatch,
  sharedRuns,
  tokenize,
  topicSimilarity,
  wordCount,
} from "./text.mjs";
import {
  CATEGORIES,
  addDays,
  checkBilingual,
  checkDuplicates,
  checkEditorial,
  dateInZone,
  editionWindow,
  evaluateSource,
  isSafeHttpsUrl,
  loadHistory,
  loadSourcePolicy,
  normalizeUrl,
  resolvePublishedDate,
  sameSite,
  siteOf,
  validateEdition,
  verifyAgainstArticle,
} from "./validate.mjs";

/**
 * Provenance key for matching a candidate URL against URLs returned by the
 * web search tool. Starts from normalizeUrl (lowercase host, no www, no
 * fragment, no known tracking parameters, sorted remaining parameters, no
 * trailing slash) and additionally:
 * - treats http and https forms of the same URL as one page;
 * - applies RFC 3986 percent-encoding normalization to the path (uppercase
 *   hex; unreserved characters decoded).
 * Host, path and all non-tracking query parameters must still match exactly.
 */
export function provenanceKey(raw) {
  const url = new URL(normalizeUrl(raw));
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`unsupported scheme ${url.protocol}`);
  if (url.username || url.password) throw new Error("credentials in URL");
  url.protocol = "https:";
  url.pathname = url.pathname.replace(/%[0-9a-f]{2}/gi, (escape) => {
    const ch = String.fromCharCode(parseInt(escape.slice(1), 16));
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : escape.toUpperCase();
  });
  return url.href;
}

/** Diagnostics for a candidate URL that matched no returned source (F1). */
function provenanceMiss(candidateKey, sourceIndex) {
  const host = new URL(candidateKey).hostname;
  const sameHost = [...sourceIndex.entries()].filter(
    ([key]) => new URL(key).hostname === host,
  );
  const path = new URL(candidateKey).pathname.replace(/[/_-]+/g, " ");
  let nearest = null;
  for (const [key, source] of sameHost) {
    const similarity = topicSimilarity(
      path,
      new URL(key).pathname.replace(/[/_-]+/g, " "),
    );
    if (!nearest || similarity > nearest.similarity)
      nearest = {
        url: source.url,
        origin: source.origin,
        similarity: Math.round(similarity * 100) / 100,
      };
  }
  return {
    matched: false,
    candidateKey,
    sameHostSourceCount: sameHost.length,
    sameHostSources: sameHost.slice(0, 5).map(([, s]) => s.url),
    nearest,
  };
}

// A1: what makes two supported claims count as one.
export const DISTINCT_EVIDENCE = Object.freeze({
  // Quotes overlapping on at least this share of the shorter quote's words
  // are the same evidence (identical quotes, or one inside the other).
  sameEvidenceOverlap: 0.8,
  // Claims this similar in wording, with the same numbers, state the same fact.
  sameFactSimilarity: 0.75,
  minClaimWords: 3,
});

/** A claim with a verbatim quote, a valid paragraph id and a real statement. */
function usableClaim(cl) {
  return (
    cl?.quoteFound === true &&
    typeof cl.text === "string" &&
    typeof cl.quote === "string" &&
    wordCount(cl.text) >= DISTINCT_EVIDENCE.minClaimWords &&
    wordCount(cl.quote) >= DISTINCT_EVIDENCE.minClaimWords &&
    /^p\d{1,3}$/.test(cl.paragraphId ?? "")
  );
}

/**
 * Why claim `a` duplicates claim `b`, or null when they are distinct.
 * - same-evidence: their quotes are the same passage (one covers at least 80%
 *   of the other). Different sentences of one paragraph stay distinct.
 * - same-fact: the claims say the same thing in nearly the same words and
 *   with the same numbers, even if quoted from two places in the article.
 */
function duplicateReason(a, b) {
  const shorter = Math.min(tokenize(a.quote).length, tokenize(b.quote).length);
  if (shorter === 0) return "same-evidence";
  if (
    sharedRuns(a.quote, b.quote, 1).longest / shorter >=
    DISTINCT_EVIDENCE.sameEvidenceOverlap
  )
    return "same-evidence";
  if (normalizeForMatch(a.text) === normalizeForMatch(b.text))
    return "same-fact";
  const sameNumbers =
    extractNumbers(a.text).join(",") === extractNumbers(b.text).join(",");
  if (
    sameNumbers &&
    topicSimilarity(a.text, b.text) >= DISTINCT_EVIDENCE.sameFactSimilarity
  )
    return "same-fact";
  return null;
}

/**
 * Claims that count toward the "at least N supported claims" rule: usable,
 * accepted by `accept` (e.g. verdict entailed), and not a duplicate of a claim
 * already counted. c1 is considered first, so a later duplicate is discounted
 * rather than the main claim. Returns { counted, duplicates }.
 */
export function distinctClaims(claims, accept = () => true) {
  // Malformed entries (null, non-objects) are ignored, never counted.
  const ordered = (Array.isArray(claims) ? claims : [])
    .filter((cl) => cl !== null && typeof cl === "object")
    .sort((a, b) =>
      a.id === "c1"
        ? -1
        : b.id === "c1"
          ? 1
          : String(a.id).localeCompare(String(b.id)),
    );
  const counted = [];
  const duplicates = [];
  for (const cl of ordered) {
    if (!usableClaim(cl) || !accept(cl)) continue;
    const match = counted
      .map((kept) => ({ kept, reason: duplicateReason(cl, kept) }))
      .find((m) => m.reason);
    if (match) {
      duplicates.push({ id: cl.id, of: match.kept.id, reason: match.reason });
      continue;
    }
    counted.push(cl);
  }
  return { counted, duplicates };
}

export const EXIT = Object.freeze({
  edition: 0,
  error: 1,
  "no-edition": 2,
  "budget-stop": 3,
  blocked: 4,
});

// Problems a single rewrite can plausibly fix.
const REPAIRABLE = new Set([
  "TOO_LONG",
  "NUMBER_MISMATCH",
  "EDITORIAL_WORDING",
  "FR_UNTRANSLATED",
  "FR_LANGUAGE",
  "EN_LANGUAGE",
  "COPYRIGHT_OVERLAP",
  "ATTRIBUTION_MISSING",
  "SELF_REPORT_OVERSTATED",
]);

/** True when the final reviewer approved an entry without any reservation. */
export function passesReview(verdict) {
  return Boolean(
    verdict &&
    verdict.faithful &&
    verdict.unsupportedSentences.length === 0 &&
    verdict.translationIssues.length === 0 &&
    !verdict.copyrightConcern,
  );
}

// Hard cap on review repairs per run, whatever config.json says.
export const MAX_REVIEW_REPAIRS = 1;

/**
 * The reviewer's objections as repair instructions, or null when a rewrite
 * cannot address the rejection: a missing verdict, a copyright concern (the
 * deterministic copyright check already passed, so the reviewer's view
 * stands), or a rejection that names no sentence or French problem.
 */
export function reviewRepairProblems(verdict) {
  if (!verdict || verdict.missing || verdict.copyrightConcern) return null;
  const problems = [
    ...verdict.unsupportedSentences.map(
      (u) =>
        `UNSUPPORTED (${u.problem}): "${shortText(u.sentence, 400)}" ${shortText(u.reason, 300)}`,
    ),
    ...verdict.translationIssues.map((t) => `FRENCH: ${shortText(t, 400)}`),
  ];
  return problems.length ? problems : null;
}

const API_ASSUMPTIONS = [
  "verified by the 2026-10-19 probe: web_search with strict json_schema output, max_tool_calls 1 accepted and respected, action.sources returned, search content in input_tokens, reasoning tokens in output_tokens, both models available",
  "unverified: whether web_search_call items beyond max_tool_calls are page-open/find actions and whether those are billed (run-26e47111 returned 6 items for a limit of 5); they are counted at the search price as a conservative allowance",
  "unverified: the action field that carries a page-open/find URL (action.url is accepted when present)",
  "unverified: medium reasoning effort on gpt-6.1-sol for writing",
];

const shortText = (value, max) => cleanText(value ?? "").slice(0, max);

/** Picks the article's own headline (never a model-written one). */
function articleHeadline(article) {
  for (const value of [
    article.jsonLdHeadline,
    article.ogTitle,
    article.h1,
    article.titleWithoutSite,
    article.title,
  ]) {
    const text = shortText(value, 400);
    if (text && text.length <= 200) return text;
  }
  return "";
}

function articleUrl(fetched) {
  try {
    if (fetched.article.canonicalUrl) {
      const canonical = new URL(fetched.article.canonicalUrl, fetched.finalUrl);
      if (
        canonical.protocol === "https:" &&
        sameSite(canonical.href, fetched.finalUrl)
      ) {
        canonical.hash = "";
        return canonical.href;
      }
    }
  } catch {
    // fall through to the final URL
  }
  return fetched.finalUrl;
}

function languageTag(article) {
  const tag = (article.lang ?? "").toLowerCase().split(/[-_]/)[0];
  if (/^[a-z]{2,3}$/.test(tag)) return tag;
  return guessLanguage(article.text) ?? "en";
}

/**
 * Runs the pipeline. All side-effecting dependencies are injected:
 * client (openai.mjs), fetcher (fetch.mjs), policy, history, clock and nonce.
 * Returns { status, edition|null, report }.
 */
export async function runResearch({
  edition: editionDate,
  now = new Date(),
  config,
  policy,
  history = [],
  client,
  meter,
  fetcher,
  mode = "dry-run",
  allowProvisionalPolicy = false,
  monthSpentUsd,
  nonce = randomBytes(8).toString("hex"),
  runId = `run-${randomBytes(4).toString("hex")}`,
}) {
  const startedAt = new Date().toISOString();
  const window = editionWindow(editionDate);
  const candidates = [];
  const report = {
    schema: "ourfaces-tech-brief-research-report/1",
    runId,
    mode,
    edition: editionDate,
    window: {
      firstDate: window.firstDate,
      lastDate: window.lastDate,
      cutoffUtc: window.cutoff.toISOString(),
    },
    startedAt,
    status: null,
    reason: null,
    policy: { status: policy?.status ?? "unset", provisionalOverride: false },
    models: Object.fromEntries(
      Object.entries(config.stages).map(([stage, s]) => [stage, s.model]),
    ),
    apiAssumptionsPendingLiveVerification: API_ASSUMPTIONS,
    editorialPolicy: EDITORIAL_POLICY,
    discovery: { mode: null, sourcesSeen: 0, fallbackUsed: false },
    candidates,
    selected: [],
    validation: null,
    budget: null,
  };

  const finish = (status, reason, edition = null) => {
    report.status = status;
    report.reason = reason;
    report.finishedAt = new Date().toISOString();
    report.budget = {
      note: "Estimated from API usage data and configured prices. Not a billing guarantee; the provider-side hard spending limit is the backstop.",
      perRunCeilingUsd: config.budget.perRunUsd,
      monthlyBudgetUsd: config.budget.monthlyUsd,
      plannedProviderHardLimitUsd: config.budget.plannedProviderHardLimitUsd,
      monthSpentBeforeRunUsd: monthSpentUsd ?? null,
      runEstimatedBilledUsd: meter.billedEstimateUsd,
      runUnknownChargesUsd: meter.unknownChargesUsd,
      runTotalCountedUsd: meter.spentUsd,
      retriesRemaining: meter.retriesLeft,
      estimateOverruns: meter.overruns,
      calls: meter.calls,
      byStage: Object.values(
        meter.calls.reduce((acc, c) => {
          const s = (acc[c.stage] ??= {
            stage: c.stage,
            calls: 0,
            searches: 0,
            otherActions: 0,
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            costUsd: 0,
            unknownChargesUsd: 0,
          });
          s.calls++;
          s.searches += c.searches ?? 0;
          s.otherActions += c.otherActions ?? 0;
          s.inputTokens += c.inputTokens ?? 0;
          s.outputTokens += c.outputTokens ?? 0;
          s.reasoningTokens += c.reasoningTokens ?? 0;
          s.costUsd = Math.round((s.costUsd + (c.costUsd ?? 0)) * 1e6) / 1e6;
          s.unknownChargesUsd =
            Math.round(
              (s.unknownChargesUsd + (c.unknownChargeUsd ?? 0)) * 1e6,
            ) / 1e6;
          return acc;
        }, {}),
      ),
    };
    return { status, edition, report };
  };

  // --- 0. Preflight (no paid calls) -------------------------------------------------
  if (!policy) return finish("blocked", "No source policy loaded");
  if (policy.status !== "approved") {
    if (mode === "production")
      return finish(
        "blocked",
        `Source policy is "${policy.status ?? "unset"}"; production requires an approved policy (no override possible)`,
      );
    if (!allowProvisionalPolicy)
      return finish(
        "blocked",
        `Source policy is "${policy.status ?? "unset"}"; pass the provisional-policy override for non-production runs`,
      );
    report.policy.provisionalOverride = true;
  }
  if (new Date(`${editionDate}T00:00:00Z`).getUTCDay() !== 6)
    return finish("blocked", "Edition date must be a Saturday");
  // Phase 4: a production run researches a complete week only. Dry runs keep
  // working for any past or current edition.
  if (mode === "production") {
    const block = productionResearchBlock(editionDate, now);
    if (block) return finish("blocked", block);
  }
  if (
    typeof monthSpentUsd !== "number" ||
    !Number.isFinite(monthSpentUsd) ||
    monthSpentUsd < 0
  ) {
    return finish(
      "blocked",
      "Month-to-date spend is unknown; refusing to run (fail closed)",
    );
  }
  if (monthSpentUsd + config.budget.perRunUsd > config.budget.monthlyUsd) {
    return finish(
      "budget-stop",
      `Monthly budget: $${monthSpentUsd} spent + $${config.budget.perRunUsd} run ceiling exceeds $${config.budget.monthlyUsd}`,
    );
  }

  const stage = (name) => config.stages[name];
  const call = (name, prompt, extra = {}) =>
    client.respond(name, {
      model: stage(name).model,
      reasoningEffort: stage(name).reasoningEffort,
      maxOutputTokens: stage(name).maxOutputTokens,
      instructions: prompt.instructions,
      input: prompt.input,
      ...extra,
    });

  try {
    // --- 1. Discovery ---------------------------------------------------------------
    const discovered = [];
    // Provenance evidence: URLs the web search tool itself returned (search
    // sources, citations, page-open/find action URLs), keyed by provenanceKey.
    const sourceIndex = new Map();
    const addSource = (raw, origin) => {
      if (typeof raw !== "string") return;
      try {
        const key = provenanceKey(raw);
        if (!sourceIndex.has(key))
          sourceIndex.set(key, { url: raw.slice(0, 2048), origin });
      } catch {
        // unparsable or unsupported source URLs are not evidence
      }
    };
    report.discovery.calls = [];
    const blockedDomains = policy.excluded.map((e) => e.domain).slice(0, 100);
    const perCall = config.limits.candidatesPerDiscoveryCall;
    let structured = stage("discovery").structuredOutputWithSearch !== false;
    let discoveryFailures = 0;
    for (const categories of config.discoveryGroups) {
      const prompt = discoveryPrompt({
        window,
        categories,
        maxCandidates: perCall,
      });
      const searchRequest = {
        tools: [
          {
            type: "web_search",
            filters: { blocked_domains: blockedDomains },
            search_context_size: stage("discovery").searchContextSize,
          },
        ],
        toolChoice: "required",
        maxToolCalls: stage("discovery").maxToolCalls,
        include: ["web_search_call.action.sources"],
      };
      let result;
      try {
        result = await call("discovery", prompt, {
          ...searchRequest,
          ...(structured ? { schemaName: "discovery" } : {}),
        });
      } catch (error) {
        const incompatible =
          structured &&
          stage("discovery").structuredOutputWithSearch === "auto" &&
          error.kind === "BAD_REQUEST";
        const unusable = structured && error.kind === "INVALID_OUTPUT";
        if (!incompatible && !unusable) {
          if (["QUOTA", "BUDGET"].includes(error.kind)) throw error;
          discoveryFailures++;
          continue;
        }
        // Fallback: candidates come from a no-tools conversion call. If the
        // combined request was rejected, search again without the schema;
        // if the structured output was unusable, convert what was returned.
        report.discovery.fallbackUsed = true;
        if (unusable) {
          result = {
            json: null,
            text: error.details.text ?? "",
            sources: error.details.sources ?? [],
            citations: error.details.citations ?? [],
            actions: error.details.actions ?? [],
            actionUrls: error.details.actionUrls ?? [],
          };
        } else {
          structured = false;
          try {
            result = await call("discovery", prompt, searchRequest);
          } catch (retryError) {
            if (["QUOTA", "BUDGET"].includes(retryError.kind)) throw retryError;
            discoveryFailures++;
            continue;
          }
        }
      }
      const actionUrls = result.actionUrls ?? [];
      result.sources.forEach((u) => addSource(u, "search-source"));
      result.citations.forEach((u) => addSource(u, "citation"));
      actionUrls.forEach((u) => addSource(u, "action-url"));
      const sources = [
        ...new Set([...result.sources, ...result.citations, ...actionUrls]),
      ];
      // F1 diagnostics: what the tool did and returned (URLs and queries only).
      const actions = result.actions ?? [];
      report.discovery.calls.push({
        group: categories.join("+"),
        structuredOutput: Boolean(result.json),
        toolItems: actions.length,
        billableSearches: actions.filter((a) => a.billable).length,
        otherActions: actions.filter((a) => !a.billable).length,
        actions,
        sources: [...new Set(result.sources)].slice(0, 150),
        citations: [...new Set(result.citations)].slice(0, 50),
        actionUrls: [...new Set(actionUrls)].slice(0, 50),
      });
      let list = result.json?.candidates;
      if (!list) {
        const conversion = await call(
          "discoveryConversion",
          discoveryConversionPrompt({
            text: result.text,
            sources: sources.slice(0, 50),
            categories,
            maxCandidates: perCall,
            nonce,
          }),
          { schemaName: "discoveryConversion" },
        );
        list = conversion.json.candidates;
      }
      for (const c of list.slice(0, perCall))
        discovered.push({ ...c, group: categories.join("+") });
    }
    report.discovery.mode = structured ? "structured" : "plain-text+conversion";
    report.discovery.sourcesSeen = sourceIndex.size;
    if (discoveryFailures === config.discoveryGroups.length)
      return finish("error", "All discovery calls failed");

    // --- 2. Policy, citation and duplicate filters -------------------------------------
    const seenUrls = new Set();
    for (const [i, c] of discovered.entries()) {
      const entry = {
        key: `k${i + 1}`,
        url: shortText(c.url, 2048),
        discoveredHeadline: shortText(c.headline, 300),
        proposedCategory: c.category,
        claimedDate: c.publishedDate,
        status: "candidate",
        reason: null,
        verification: null,
        corroboration: null,
      };
      candidates.push(entry);
      const drop = (reason) => {
        entry.status = "dropped";
        entry.reason = reason;
      };
      // Full URL/host/port policy is enforced by the secure fetcher; here the
      // URL only has to be a well-formed https URL without credentials.
      let normalized;
      let key;
      try {
        if (!isSafeHttpsUrl(entry.url)) throw new Error("not a safe https URL");
        normalized = normalizeUrl(entry.url);
        key = provenanceKey(entry.url);
      } catch (error) {
        drop(`INVALID_URL: ${error.message}`);
        continue;
      }
      // Anti-fabrication: the URL must be one the search tool actually
      // returned (same host, path and non-tracking query). A URL written by
      // the model is never accepted on its own.
      const match = sourceIndex.get(key);
      if (!match) {
        entry.provenance = provenanceMiss(key, sourceIndex);
        drop(
          "FABRICATED_URL: not among the URLs returned by the web search tool",
        );
        continue;
      }
      entry.provenance = {
        matched: true,
        origin: match.origin,
        sourceUrl: match.url,
        exact: normalizeUrl(match.url) === normalized,
      };
      if (seenUrls.has(key)) {
        drop("DUPLICATE_URL");
        continue;
      }
      seenUrls.add(key);
      const verdict = evaluateSource(entry.url, policy);
      entry.sourceStatus = verdict.status;
      entry.sourceTier = verdict.tier ?? null;
      entry.sourceKind = verdict.kind ?? null;
      if (verdict.status === "excluded" || verdict.status === "review") {
        drop(`SOURCE_${verdict.status.toUpperCase()}: ${verdict.reason}`);
        continue;
      }
      const repeat = checkDuplicates(
        [{ url: entry.url, sourceHeadline: entry.discoveredHeadline }],
        { history },
      );
      if (repeat.length) {
        drop(`${repeat[0].code}: ${repeat[0].message}`);
        continue;
      }
      if (
        c.publishedDate !== "unknown" &&
        (c.publishedDate < window.firstDate ||
          c.publishedDate > window.lastDate)
      ) {
        drop(`DATE_WINDOW: discovery reported ${c.publishedDate}`);
        continue;
      }
    }
    // F6: at most maxCandidatesPerSite candidates per site go on to be
    // fetched (selection later keeps one story per site anyway).
    const perSite = new Map();
    for (const c of candidates.filter((x) => x.status === "candidate")) {
      const site = siteOf(new URL(c.url).hostname);
      const count = (perSite.get(site) ?? 0) + 1;
      perSite.set(site, count);
      if (count > config.limits.maxCandidatesPerSite)
        Object.assign(c, {
          status: "dropped",
          reason: `SITE_CAP: more than ${config.limits.maxCandidatesPerSite} candidates from ${site}`,
        });
    }
    const toFetch = candidates
      .filter((c) => c.status === "candidate")
      .sort((a, b) => (a.sourceTier ?? 3) - (b.sourceTier ?? 3))
      .slice(0, config.limits.maxCandidatesToFetch);
    candidates
      .filter((c) => c.status === "candidate" && !toFetch.includes(c))
      .forEach((c) =>
        Object.assign(c, {
          status: "dropped",
          reason: "NOT_FETCHED: over the fetch limit",
        }),
      );

    // --- 3. Secure retrieval and article gates -------------------------------------------
    const fetchedByKey = new Map();
    for (const c of toFetch) {
      const fetched = await fetcher.fetchArticle(c.url);
      const drop = (reason) => Object.assign(c, { status: "dropped", reason });
      if (!fetched.ok) {
        drop(`SOURCE_UNAVAILABLE: ${fetched.code}`);
        continue;
      }
      const article = fetched.article;
      const published = resolvePublishedDate(article);
      c.finalUrl = fetched.finalUrl;
      c.url = articleUrl(fetched);
      c.sourceHeadline = articleHeadline(article);
      c.publisher =
        shortText(article.siteName, 100) ||
        new URL(c.url).hostname.replace(/^www\./, "");
      c.sourceHeadlineLang = languageTag(article);
      c.publishedOn = published.date;
      if (!c.sourceHeadline) {
        drop("NO_HEADLINE");
        continue;
      }
      if (!published.date) {
        drop("DATE_MISSING");
        continue;
      }
      if (published.conflicts.length) {
        drop(`DATE_CONFLICT: ${published.conflicts.join(", ")}`);
        continue;
      }
      if (
        published.date < window.firstDate ||
        published.date > window.lastDate ||
        published.date > dateInZone(now)
      ) {
        drop(`DATE_WINDOW: article date ${published.date}`);
        continue;
      }
      if (article.sponsored) {
        drop("SPONSORED");
        continue;
      }
      if (fetched.evidence.hiddenInjectionSignals.length) {
        drop("HIDDEN_INSTRUCTIONS");
        continue;
      }
      const evidence = buildEvidence(article, {
        maxChars: config.limits.maxEvidenceChars,
      });
      if (evidence.paragraphs.length < 2) {
        drop("INSUFFICIENT_EVIDENCE");
        continue;
      }
      c.visibleInjectionSignals = evidence.injectionSignals;
      fetchedByKey.set(c.key, { fetched, evidence });
    }

    // --- 4. Claim extraction (per article) ------------------------------------------------
    for (const c of candidates.filter(
      (x) => fetchedByKey.has(x.key) && x.status === "candidate",
    )) {
      const { evidence } = fetchedByKey.get(c.key);
      let result;
      try {
        result = await call(
          "extraction",
          extractionPrompt({
            key: c.key,
            headline: c.sourceHeadline,
            publisher: c.publisher,
            paragraphs: evidence.paragraphs,
            maxClaims: config.limits.maxClaimsPerStory,
            nonce,
          }),
          { schemaName: "extraction" },
        );
      } catch (error) {
        if (["QUOTA", "BUDGET"].includes(error.kind)) throw error;
        Object.assign(c, {
          status: "dropped",
          reason: `EXTRACTION_FAILED: ${error.kind}`,
        });
        continue;
      }
      const x = result.json;
      c.category = CATEGORIES.includes(x.category)
        ? x.category
        : c.proposedCategory;
      c.practicalRelevance = x.practicalRelevance;
      const paragraphs = new Map(
        evidence.paragraphs.map((p) => [p.id, p.text]),
      );
      const claims = x.claims.map((claim) => {
        const paragraph = paragraphs.get(claim.paragraphId);
        const quoteFound =
          Boolean(paragraph) && containsQuote(paragraph, claim.quote);
        return {
          id: claim.id,
          text: shortText(claim.text, 400),
          paragraphId: claim.paragraphId,
          quote: shortText(claim.quote, 600),
          quoteFound,
          verdict: null,
        };
      });
      c.verification = {
        method:
          "claim entailed by a verbatim quote from this story's original article",
        status: "pending",
        claims,
      };
      // F5: promotional means advertising, marketing, hype or too little
      // technical substance (fixed rules). A vendor self-report is not
      // rejected for that alone; it must be attributed when written.
      c.editorial = classifyEditorial(x.editorial, {
        publisher: c.publisher,
        sourceSite: siteOf(new URL(c.url).hostname),
        sourceKind: c.sourceKind,
      });
      const flags = [
        !x.relevant && "NOT_RELEVANT",
        !x.mainSubjectMatchesHeadline && "SUBJECT_MISMATCH",
        c.editorial.promotionalCode,
        x.isOpinion && "OPINION",
      ].filter(Boolean);
      if (flags.length) {
        Object.assign(c, { status: "dropped", reason: flags.join(",") });
        continue;
      }
      // A1: only distinct, well-formed claims with verbatim quotes count.
      const quoted = distinctClaims(claims);
      c.verification.duplicates = quoted.duplicates;
      const coreQuoted = quoted.counted.some((cl) => cl.id === "c1");
      if (
        !coreQuoted ||
        quoted.counted.length < config.limits.minVerifiedClaims
      ) {
        Object.assign(c, {
          status: "dropped",
          reason:
            coreQuoted && quoted.duplicates.length
              ? "INSUFFICIENT_DISTINCT_EVIDENCE: too few distinct claims with verbatim quotes"
              : "QUOTES_NOT_FOUND: core claim or too few claims have verbatim quotes in the article",
        });
        c.verification.status = "failed";
      }
    }

    // --- 5. Verification against the original article ----------------------------------------
    const toVerify = candidates.filter(
      (c) => c.status === "candidate" && c.verification,
    );
    if (toVerify.length) {
      const items = toVerify.flatMap((c) =>
        c.verification.claims
          .filter((cl) => cl.quoteFound)
          .map((cl) => ({
            key: c.key,
            claimId: cl.id,
            claim: cl.text,
            quote: cl.quote,
          })),
      );
      let result;
      try {
        result = await call(
          "verification",
          verificationPrompt({ items, nonce }),
          { schemaName: "verification" },
        );
      } catch (error) {
        if (["QUOTA", "BUDGET"].includes(error.kind)) throw error;
        return finish(
          "error",
          `Verification failed: ${error.kind}: ${error.message}`,
        );
      }
      const verdicts = new Map(
        result.json.results.map((r) => [`${r.key}/${r.claimId}`, r.verdict]),
      );
      // Verified = the main claim is entailed and at least minVerifiedClaims
      // DISTINCT claims are entailed (A1: duplicates count once).
      const applyVerification = (c) => {
        const supported = distinctClaims(
          c.verification.claims,
          (cl) => cl.verdict === "entailed",
        );
        const coreOk = supported.counted.some((cl) => cl.id === "c1");
        c.verification.distinctSupported = supported.counted.length;
        c.verification.duplicates = supported.duplicates;
        c.verification.status =
          coreOk && supported.counted.length >= config.limits.minVerifiedClaims
            ? "verified"
            : "failed";
        if (c.verification.status === "verified")
          Object.assign(c, { status: "candidate", reason: null });
        else
          Object.assign(c, {
            status: "dropped",
            reason:
              coreOk && supported.duplicates.length
                ? "INSUFFICIENT_DISTINCT_EVIDENCE: too few distinct claims entailed by the article"
                : "UNSUPPORTED_CLAIMS: core claim or too few claims entailed by the article",
          });
      };
      for (const c of toVerify) {
        for (const cl of c.verification.claims)
          cl.verdict = cl.quoteFound
            ? (verdicts.get(`${c.key}/${cl.id}`) ?? "missing")
            : "not_checked";
        applyVerification(c);
      }

      // F4: one bounded re-extraction of a core claim (c1) that its own quote
      // did not fully support, only for stories that could otherwise pass.
      // The replacement must be found verbatim in the article and must be
      // judged "entailed" again; thresholds are unchanged.
      const reasons = new Map(
        result.json.results.map((r) => [`${r.key}/${r.claimId}`, r.reason]),
      );
      const retryable = toVerify
        .filter((c) => {
          const core = c.verification.claims.find((cl) => cl.id === "c1");
          const othersEntailed = distinctClaims(
            c.verification.claims.filter((cl) => cl.id !== "c1"),
            (cl) => cl.verdict === "entailed",
          ).counted.length;
          return (
            c.verification.status === "failed" &&
            core?.quoteFound &&
            ["partial", "not_entailed"].includes(core.verdict) &&
            othersEntailed >= config.limits.minVerifiedClaims - 1
          );
        })
        .slice(0, config.limits.maxCoreReextractions);
      const replacements = [];
      for (const c of retryable) {
        const core = c.verification.claims.find((cl) => cl.id === "c1");
        const { evidence } = fetchedByKey.get(c.key);
        c.verification.coreReextraction = {
          previous: {
            text: core.text,
            quote: core.quote,
            paragraphId: core.paragraphId,
            verdict: core.verdict,
            reason: shortText(reasons.get(`${c.key}/c1`) ?? "", 300),
          },
          outcome: null,
        };
        let reextracted;
        try {
          reextracted = await call(
            "coreReextraction",
            coreReextractionPrompt({
              key: c.key,
              headline: c.sourceHeadline,
              publisher: c.publisher,
              paragraphs: evidence.paragraphs,
              rejected: core,
              nonce,
            }),
            { schemaName: "coreClaim" },
          );
        } catch (error) {
          if (["QUOTA", "BUDGET"].includes(error.kind)) throw error;
          c.verification.coreReextraction.outcome = `FAILED: ${error.kind}`;
          continue;
        }
        const { found, claim } = reextracted.json;
        const paragraph = evidence.paragraphs.find(
          (p) => p.id === claim.paragraphId,
        )?.text;
        if (!found || !paragraph || !containsQuote(paragraph, claim.quote)) {
          c.verification.coreReextraction.outcome = found
            ? "QUOTE_NOT_FOUND"
            : "NO_SINGLE_QUOTE";
          continue;
        }
        replacements.push({
          c,
          claim: {
            id: "c1",
            text: shortText(claim.text, 400),
            paragraphId: claim.paragraphId,
            quote: shortText(claim.quote, 600),
            quoteFound: true,
            verdict: null,
            reextracted: true,
          },
        });
      }
      if (replacements.length) {
        let reverified = null;
        try {
          reverified = await call(
            "reverification",
            verificationPrompt({
              items: replacements.map(({ c, claim }) => ({
                key: c.key,
                claimId: "c1",
                claim: claim.text,
                quote: claim.quote,
              })),
              nonce,
            }),
            { schemaName: "reverification" },
          );
        } catch (error) {
          if (["QUOTA", "BUDGET"].includes(error.kind)) throw error;
          replacements.forEach(
            ({ c }) =>
              (c.verification.coreReextraction.outcome = `REVERIFICATION_FAILED: ${error.kind}`),
          );
        }
        if (reverified) {
          const newVerdicts = new Map(
            reverified.json.results
              .filter((r) => r.claimId === "c1")
              .map((r) => [r.key, r.verdict]),
          );
          for (const { c, claim } of replacements) {
            claim.verdict = newVerdicts.get(c.key) ?? "missing";
            c.verification.coreReextraction.outcome = claim.verdict;
            if (claim.verdict !== "entailed") continue;
            c.verification.claims = c.verification.claims.map((cl) =>
              cl.id === "c1" ? claim : cl,
            );
            // Same rule as first-pass verification: a replacement that merely
            // repeats another claim's evidence or fact cannot make it pass.
            applyVerification(c);
          }
        }
      }
    }

    // --- 6. Independent corroboration and ranking ----------------------------------------------
    const verified = candidates.filter(
      (c) => c.status === "candidate" && c.verification?.status === "verified",
    );
    const topic = (c) =>
      `${c.sourceHeadline} ${c.verification.claims.find((cl) => cl.id === "c1").text}`;
    for (const c of verified) {
      const others = verified.filter(
        (o) =>
          o !== c &&
          siteOf(new URL(o.url).hostname) !== siteOf(new URL(c.url).hostname) &&
          topicSimilarity(topic(c), topic(o)) >=
            config.limits.corroborationSimilarity,
      );
      c.corroboration = {
        status: others.length ? "corroborated" : "uncorroborated",
        by: others.map((o) => o.url),
        note: "Another site independently reports the same event. This does not verify any individual claim.",
      };
    }
    const score = (c) =>
      (4 - (c.sourceTier ?? 3)) * 2 +
      Math.min(c.verification.distinctSupported, 5) +
      (c.practicalRelevance ?? 1) +
      (c.corroboration.status === "corroborated" ? 2 : 0) +
      (Date.parse(c.publishedOn) - Date.parse(window.firstDate)) /
        (8 * 86400000);
    verified.forEach((c) => (c.score = Math.round(score(c) * 1000) / 1000));
    verified.sort((a, b) => b.score - a.score);

    // One story per event (corroborating reports collapse into the best one) and per site.
    const picked = [];
    const takeable = (c) =>
      !picked.some(
        (p) =>
          siteOf(new URL(p.url).hostname) === siteOf(new URL(c.url).hostname),
      ) && !picked.some((p) => p.corroboration.by.includes(c.url));
    for (const cat of CATEGORIES) {
      const best = verified.find((c) => c.category === cat && takeable(c));
      if (best && picked.length < config.limits.maxStories) picked.push(best);
    }
    for (const c of verified)
      if (
        picked.length < config.limits.maxStories &&
        !picked.includes(c) &&
        takeable(c)
      )
        picked.push(c);
    for (const c of verified) {
      if (!picked.includes(c))
        Object.assign(c, {
          status: "dropped",
          reason: picked.some((p) => p.corroboration.by.includes(c.url))
            ? "SAME_EVENT_AS_SELECTED"
            : "NOT_SELECTED",
        });
    }
    if (picked.length < config.limits.minStories)
      return finish(
        "no-edition",
        `Only ${picked.length} verified stories (need ${config.limits.minStories})`,
      );
    if (
      new Set(picked.map((c) => c.category)).size < config.limits.minCategories
    ) {
      return finish(
        "no-edition",
        `Selected stories cover fewer than ${config.limits.minCategories} categories`,
      );
    }

    // --- 7. Writing ------------------------------------------------------------------------
    const selfReportedBy = (c) =>
      c.editorial.vendorSelfReport ? c.editorial.attributedTo : null;
    const editorialEvidence = (c) => ({
      contentType: c.editorial.contentType,
      technicalSubstance: c.editorial.technicalSubstance,
      vendorSelfReport: c.editorial.vendorSelfReport,
      attributedTo: c.editorial.attributedTo,
    });
    const writingInput = (c) => ({
      key: c.key,
      category: c.category,
      sourceHeadline: c.sourceHeadline,
      publisher: c.publisher,
      publishedOn: c.publishedOn,
      selfReportedBy: selfReportedBy(c),
      claims: c.verification.claims
        .filter((cl) => cl.verdict === "entailed")
        .map((cl) => ({ id: cl.id, text: cl.text })),
    });
    let written;
    try {
      written = await call(
        "writing",
        writingPrompt({ stories: picked.map(writingInput) }),
        { schemaName: "writing" },
      );
    } catch (error) {
      if (["QUOTA", "BUDGET"].includes(error.kind)) throw error;
      return finish("error", `Writing failed: ${error.kind}: ${error.message}`);
    }
    const texts = new Map();
    // A repair may only replace the entries it was asked to fix.
    const acceptText = (entries, onlyKeys = null) => {
      for (const s of entries) {
        if (onlyKeys && !onlyKeys.has(s.key)) continue;
        const c = picked.find((p) => p.key === s.key);
        if (!c) continue;
        const allowed = new Set(
          c.verification.claims
            .filter((cl) => cl.verdict === "entailed")
            .map((cl) => cl.id),
        );
        if (
          s.en.claimIds.length === 0 ||
          s.en.claimIds.some((id) => !allowed.has(id))
        )
          continue;
        texts.set(s.key, {
          en: {
            headline: cleanText(s.en.headline),
            summary: cleanText(s.en.summary),
            whyItMatters: cleanText(s.en.whyItMatters),
          },
          fr: {
            headline: cleanText(s.fr.headline),
            summary: cleanText(s.fr.summary),
            whyItMatters: cleanText(s.fr.whyItMatters),
          },
          claimIds: s.en.claimIds,
        });
      }
    };
    acceptText(written.json.stories);

    // --- 8. Deterministic checks, one repair pass, then review ----------------------------------
    const storyFor = (c) => ({
      id: c.key,
      category: c.category,
      url: c.url,
      publisher: c.publisher,
      sourcePublishedOn: c.publishedOn,
      sourceHeadline: c.sourceHeadline,
      sourceHeadlineLang: c.sourceHeadlineLang,
      ...texts.get(c.key),
      evidence: { editorial: editorialEvidence(c) },
    });
    const deterministicIssues = (c) => {
      if (!texts.has(c.key))
        return [{ code: "MISSING_TEXT", message: "No valid writing output" }];
      const story = storyFor(c);
      const { fetched } = fetchedByKey.get(c.key);
      return [
        ...checkBilingual(story).errors,
        ...checkEditorial(story),
        ...checkAttribution(story),
        ...verifyAgainstArticle(story, fetched).errors,
      ];
    };
    let issues = new Map(picked.map((c) => [c.key, deterministicIssues(c)]));
    const repairable = picked.filter((c) => {
      const list = issues.get(c.key);
      return (
        list.length > 0 &&
        texts.has(c.key) &&
        list.every((i) => REPAIRABLE.has(i.code))
      );
    });
    if (repairable.length) {
      try {
        const repaired = await call(
          "repair",
          repairPrompt({
            stories: repairable.map((c) => ({
              ...writingInput(c),
              current: texts.get(c.key),
              problems: issues.get(c.key).map((i) => `${i.code}: ${i.message}`),
            })),
          }),
          { schemaName: "repair" },
        );
        acceptText(
          repaired.json.stories,
          new Set(repairable.map((c) => c.key)),
        );
        report.repairPass = { stories: repairable.map((c) => c.key) };
      } catch (error) {
        if (["QUOTA", "BUDGET"].includes(error.kind)) throw error;
        report.repairPass = { failed: error.kind };
      }
      issues = new Map(picked.map((c) => [c.key, deterministicIssues(c)]));
    }
    let remaining = picked.filter((c) => {
      const list = issues.get(c.key);
      if (list.length)
        Object.assign(c, {
          status: "dropped",
          reason: `CHECKS_FAILED: ${[...new Set(list.map((i) => i.code))].join(",")}`,
        });
      return list.length === 0;
    });
    if (remaining.length < config.limits.minStories)
      return finish(
        "no-edition",
        `Only ${remaining.length} stories passed deterministic checks`,
      );

    // The reviewer sees the same claims and source name the writer had, so
    // that naming the publisher is not mistaken for an unsupported fact.
    const reviewInput = (c) => ({
      key: c.key,
      publisher: c.publisher,
      selfReportedBy: selfReportedBy(c),
      claims: writingInput(c).claims,
      en: texts.get(c.key).en,
      fr: texts.get(c.key).fr,
    });
    const review = (list) =>
      call("review", reviewPrompt({ stories: list.map(reviewInput) }), {
        schemaName: "review",
      });
    let reviewed;
    try {
      reviewed = await review(remaining);
    } catch (error) {
      if (["QUOTA", "BUDGET"].includes(error.kind)) throw error;
      return finish("error", `Review failed: ${error.kind}: ${error.message}`);
    }
    const verdicts = new Map(reviewed.json.stories.map((r) => [r.key, r]));
    const approved = new Set();
    for (const c of remaining) {
      const r = verdicts.get(c.key);
      c.review = r ?? { missing: true };
      c.reviewedText = texts.get(c.key);
      if (passesReview(r)) approved.add(c);
    }

    // Review repair (run-7eaa279d): rejected wording gets at most one
    // rewrite. Only the rejected entries are rewritten; each rewrite must pass
    // every deterministic check and a second, independent review (which is not
    // shown the first review's objections). Anything else stays rejected.
    const repairAttempts = Math.min(
      Number.isInteger(config.limits.reviewRepairAttempts)
        ? config.limits.reviewRepairAttempts
        : 0,
      MAX_REVIEW_REPAIRS,
    );
    const toRepair =
      repairAttempts > 0
        ? remaining.filter(
            (c) =>
              !approved.has(c) && reviewRepairProblems(verdicts.get(c.key)),
          )
        : [];
    if (toRepair.length) {
      report.reviewRepair = { stories: toRepair.map((c) => c.key) };
      for (const c of toRepair)
        c.reviewRepair = {
          problems: reviewRepairProblems(verdicts.get(c.key)),
          outcome: "not-rewritten",
        };
      const before = new Map(toRepair.map((c) => [c.key, texts.get(c.key)]));
      try {
        const repaired = await call(
          "repair",
          repairPrompt({
            stories: toRepair.map((c) => ({
              ...writingInput(c),
              current: texts.get(c.key),
              problems: c.reviewRepair.problems,
            })),
          }),
          { schemaName: "repair" },
        );
        acceptText(repaired.json.stories, new Set(toRepair.map((c) => c.key)));
      } catch (error) {
        if (["QUOTA", "BUDGET"].includes(error.kind)) throw error;
        report.reviewRepair.failed = error.kind;
      }
      const recheck = [];
      for (const c of toRepair) {
        const rewritten = texts.get(c.key);
        if (JSON.stringify(rewritten) === JSON.stringify(before.get(c.key)))
          continue;
        c.reviewRepair.text = rewritten;
        const list = deterministicIssues(c);
        if (list.length) {
          c.reviewRepair.outcome = `checks-failed: ${[...new Set(list.map((i) => i.code))].join(",")}`;
          continue;
        }
        recheck.push(c);
      }
      if (recheck.length) {
        let second = null;
        try {
          second = await review(recheck);
        } catch (error) {
          if (["QUOTA", "BUDGET"].includes(error.kind)) throw error;
          report.reviewRepair.reviewFailed = error.kind;
        }
        const again = new Map(
          (second?.json.stories ?? []).map((r) => [r.key, r]),
        );
        for (const c of recheck) {
          const r = again.get(c.key);
          c.reviewRepair.review = r ?? { missing: true };
          c.reviewRepair.outcome = passesReview(r) ? "accepted" : "rejected";
          if (passesReview(r)) approved.add(c);
        }
      }
    }
    remaining = remaining.filter((c) => {
      if (!approved.has(c))
        Object.assign(c, {
          status: "dropped",
          reason: verdicts.get(c.key) ? "REVIEW_REJECTED" : "REVIEW_MISSING",
        });
      return approved.has(c);
    });
    if (remaining.length < config.limits.minStories)
      return finish(
        "no-edition",
        `Only ${remaining.length} stories passed review`,
      );
    if (
      new Set(remaining.map((c) => c.category)).size <
      config.limits.minCategories
    ) {
      return finish(
        "no-edition",
        `Reviewed stories cover fewer than ${config.limits.minCategories} categories`,
      );
    }

    // --- 9. Assemble and validate the Phase 1 edition ---------------------------------------------
    const stories = remaining.map((c, i) => {
      const t = texts.get(c.key);
      return {
        id: `s${i + 1}`,
        category: c.category,
        url: c.url,
        publisher: c.publisher,
        sourcePublishedOn: c.publishedOn,
        sourceHeadline: c.sourceHeadline,
        sourceHeadlineLang: c.sourceHeadlineLang,
        en: t.en,
        fr: t.fr,
        evidence: {
          verification: c.verification.claims
            .filter((cl) => cl.verdict === "entailed")
            .map((cl) => ({
              claimId: cl.id,
              claim: cl.text,
              quote: cl.quote,
              paragraphId: cl.paragraphId,
              usedInSummary: t.claimIds.includes(cl.id),
            })),
          corroboratedBy: c.corroboration.by,
          editorial: editorialEvidence(c),
        },
      };
    });
    const edition = {
      schemaVersion: 1,
      edition: editionDate,
      publishedOn: addDays(editionDate, 1),
      stories,
      generation: {
        runId,
        mode,
        policyStatus: policy.status,
        provisionalPolicyOverride: report.policy.provisionalOverride,
        models: report.models,
      },
    };
    const articles = Object.fromEntries(
      remaining.map((c, i) => [`s${i + 1}`, fetchedByKey.get(c.key).fetched]),
    );
    const validation = validateEdition(edition, {
      policy,
      now,
      history,
      articles,
    });
    report.validation = validation;
    remaining.forEach((c, i) =>
      Object.assign(c, { status: "selected", storyId: `s${i + 1}` }),
    );
    report.selected = remaining.map((c) => c.key);
    if (!validation.ok)
      return finish(
        "no-edition",
        `Final validation failed: ${validation.errors.map((e) => e.code).join(",")}`,
      );
    edition.generation.estimatedCostUsd = meter.spentUsd;
    return finish("edition", null, edition);
  } catch (error) {
    if (
      error instanceof OpenAIError &&
      (error.kind === "QUOTA" || error.kind === "BUDGET")
    )
      return finish("budget-stop", `${error.kind}: ${error.message}`);
    if (error instanceof OpenAIError)
      return finish("error", `${error.kind}: ${error.message}`);
    return finish("error", `Unexpected error: ${error.message}`);
  }
}

/** Loads config.json next to this module. */
export async function loadConfig(
  path = new URL("./config.json", import.meta.url),
) {
  return JSON.parse(await readFile(path, "utf8"));
}

// CLI ------------------------------------------------------------------------------------------
// node scripts/tech-brief/research.mjs --edition YYYY-MM-DD --out DIR --month-spent USD --paid
//   [--mode dry-run|production] [--allow-provisional-policy] [--history DIR]
// Paid API calls happen only with --paid and OPENAI_API_KEY set.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const fail = (message, code = EXIT.blocked) => {
    console.error(message);
    process.exit(code);
  };
  const editionDate = option("--edition");
  const out = option("--out");
  const mode = option("--mode") ?? "dry-run";
  if (!editionDate || !out)
    fail(
      "Usage: research.mjs --edition YYYY-MM-DD --out DIR --month-spent USD --paid [--mode dry-run|production] [--allow-provisional-policy] [--history DIR]",
    );
  if (!["dry-run", "production"].includes(mode)) fail(`Unknown mode ${mode}`);
  if (mode === "production" && args.includes("--allow-provisional-policy"))
    fail("--allow-provisional-policy is not available in production mode");
  if (!args.includes("--paid"))
    fail("Refusing to call the OpenAI API without --paid");
  // Checked again in runResearch; here it also prevents the model-list request.
  if (mode === "production") {
    const block = productionResearchBlock(editionDate, new Date());
    if (block) fail(block);
  }
  const repoSrc = fileURLToPath(new URL("../../src/", import.meta.url));
  const outDir = resolve(out);
  const rel = relative(repoSrc, outDir);
  if (!rel.startsWith("..") && !isAbsolute(rel))
    fail(
      "--out must not be inside src/; publication is a separate, reviewed step",
    );

  const config = await loadConfig();
  const policy = await loadSourcePolicy(
    new URL("./sources.json", import.meta.url),
  );
  const history = option("--history")
    ? await loadHistory(option("--history"), { beforeEdition: editionDate })
    : [];
  const meter = createMeter({
    prices: config.prices,
    perRunUsd: config.budget.perRunUsd,
    retriesPerRun: config.limits.retriesPerRun,
  });
  let client;
  let available;
  try {
    const transport = fetchTransport({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: config.apiBaseUrl,
    });
    client = createClient({ transport, config, meter });
    available = new Set(await client.listModels());
  } catch (error) {
    fail(`Cannot start: ${error.kind ?? "ERROR"}: ${error.message}`);
  }
  const missing = Object.values(config.stages)
    .map((s) => s.model)
    .filter((m) => !available.has(m));
  if (missing.length)
    fail(
      `Configured models not available to this key: ${[...new Set(missing)].join(", ")} (no substitution is made)`,
    );
  const result = await runResearch({
    edition: editionDate,
    config,
    policy,
    history,
    client,
    meter,
    fetcher: createFetcher({ sourcePolicy: policy }),
    mode,
    allowProvisionalPolicy: args.includes("--allow-provisional-policy"),
    monthSpentUsd:
      option("--month-spent") === undefined
        ? undefined
        : Number(option("--month-spent")),
  });
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "report.json"),
    `${JSON.stringify(result.report, null, 2)}\n`,
  );
  if (result.edition)
    await writeFile(
      join(outDir, "draft-edition.json"),
      `${JSON.stringify(result.edition, null, 2)}\n`,
    );
  console.log(
    JSON.stringify({
      status: result.status,
      reason: result.report.reason,
      costUsd: result.report.budget.runTotalCountedUsd,
      out: outDir,
    }),
  );
  process.exit(EXIT[result.status] ?? EXIT.error);
}
