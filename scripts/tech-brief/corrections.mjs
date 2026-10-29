// Editorial corrections: human-reviewed changes to an unpublished edition,
// applied to the authenticated research result without new research.
//
// An editor who reviewed the editorial preview writes a corrections document
// (JSON, kept outside the repository until the edition is public):
//
//   {
//     "format": "ourfaces-tech-brief-corrections/1",
//     "edition": "YYYY-MM-DD",
//     "basis": { researchRunId, workflowRunId, runAttempt, artifactId,
//                bundleDigest, originalDigest },
//     "corrections": [
//       { "storyId": "s2", "action": "revise", "reasons": ["FACTUAL_ACCURACY"],
//         "note": "why", "evidence": [{ "url": "https://...", "quote": "..." }],
//         "text": { "en": { "summary": "..." }, "fr": { "summary": "..." } } },
//       { "storyId": "s4", "action": "exclude", "reasons": ["UNVERIFIABLE_CLAIM"],
//         "note": "why", "evidence": [] }
//     ]
//   }
//
// Guarantees (any failure throws CorrectionError; nothing is applied):
//  - The document is bound to one research result: the ledger handoff of the
//    edition (run, attempt, artifact, bundle digest, research run id) and the
//    content digest of the uncorrected public edition (originalDigest), which
//    is what the preview of the uncorrected edition showed when nothing was
//    dropped. A document written for other research or other content is refused.
//  - Only the public text of a story (headline, summary, whyItMatters) can be
//    revised, always in English and French together; a story can be excluded.
//    URLs, publishers, dates, categories, source headlines, verification
//    evidence and run metadata never change, and no story can be added.
//  - Every revision cites evidence: a quote that publication checks against
//    the live page (verifyCorrectionSupport, after the Sunday source recheck).
//    Numbers in revised text must come from the original text, the story's
//    source article or the cited quotes, so figures cannot be invented.
//  - The research bundle is never modified: the corrected draft is a copy.
//  - Publication still validates the corrected edition in full (publish.mjs)
//    and a corrected edition is never written without an approved digest.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isSaturdayDate } from "./schedule.mjs";
import {
  UNSAFE_CHARS,
  cleanText,
  containsQuote,
  extractNumbers,
} from "./text.mjs";
import { checkCopyright, isSafeHttpsUrl } from "./validate.mjs";

export const CORRECTIONS_FORMAT = "ourfaces-tech-brief-corrections/1";
// The workflows receive the document as a GitHub secret (base64), and secrets
// are limited to 48 KB: 35 KiB of JSON is 47,788 base64 characters.
export const MAX_CORRECTIONS_BYTES = 35 * 1024;
export const SECRET_LIMIT_BYTES = 48_000;
// Reasons each action accepts (fixed lists; the note carries the explanation).
export const CORRECTION_REASONS = Object.freeze({
  revise: Object.freeze([
    "FACTUAL_ACCURACY",
    "AVAILABILITY_CLARIFICATION",
    "MISLEADING_HEADLINE",
    "DATE_CONTEXT",
    "WHY_IT_MATTERS",
    "CLARITY",
    "TRANSLATION",
  ]),
  exclude: Object.freeze([
    "FACTUAL_ACCURACY",
    "UNVERIFIABLE_CLAIM",
    "SOURCE_QUALITY",
    "EDITORIAL_JUDGMENT",
  ]),
});
const TEXT_FIELDS = ["headline", "summary", "whyItMatters"];
const BASIS_FIELDS = [
  "researchRunId",
  "workflowRunId",
  "runAttempt",
  "artifactId",
  "bundleDigest",
  "originalDigest",
];
const DOCUMENT_FIELDS = ["format", "edition", "basis", "corrections"];
const STORY_ID = /^[a-z0-9-]{1,40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_NOTE_CHARS = 1000;
const MAX_QUOTE_CHARS = 600;
const MAX_EVIDENCE = 8;
const MAX_CORRECTIONS = 10;

export class CorrectionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CorrectionError";
    this.code = code;
    this.details = details;
  }
}
const fail = (code, message, details) => {
  throw new CorrectionError(code, message, details);
};
const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const hasExactly = (value, keys) =>
  isObject(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((k) => Object.hasOwn(value, k));
const isId = (v) => Number.isSafeInteger(v) && v > 0;
// Plain NFC text only, with two independent guards: UNSAFE_CHARS (control
// characters including line breaks and tabs, and bidi controls), and no
// character that cleanText would delete (zero-width characters, byte-order
// marks, C0/C1 controls). The second is checked one character at a time, so a
// deleted character next to a space cannot hide in whitespace normalisation.
// Spaces, including French no-break spaces, are allowed.
const kept = (ch) => cleanText(`a${ch}a`).length === ch.length + 2;
const safeText = (v, max) =>
  typeof v === "string" &&
  v.trim().length > 0 &&
  v.length <= max &&
  !UNSAFE_CHARS.test(v) &&
  v.normalize("NFC") === v &&
  [...v].every(kept);
const sha256 = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** SHA-256 (hex) of the exact corrections file text: what the preview and logs name. */
export const correctionsDigest = sha256;

/** Structural problems with a parsed corrections document; [] when well formed. */
export function correctionProblems(doc) {
  if (!hasExactly(doc, DOCUMENT_FIELDS)) return ["fields"];
  const problems = [];
  if (doc.format !== CORRECTIONS_FORMAT) problems.push("format");
  if (!isSaturdayDate(doc.edition)) problems.push("edition");
  const b = doc.basis;
  if (
    !hasExactly(b, BASIS_FIELDS) ||
    typeof b.researchRunId !== "string" ||
    !/^[A-Za-z0-9-]{1,64}$/.test(b.researchRunId) ||
    !isId(b.workflowRunId) ||
    !isId(b.runAttempt) ||
    !isId(b.artifactId) ||
    !DIGEST.test(b.bundleDigest ?? "") ||
    !DIGEST.test(b.originalDigest ?? "")
  )
    problems.push("basis");
  if (
    !Array.isArray(doc.corrections) ||
    doc.corrections.length === 0 ||
    doc.corrections.length > MAX_CORRECTIONS
  )
    return [...problems, "corrections"];
  const seen = new Set();
  doc.corrections.forEach((c, i) => {
    const at = (what) => problems.push(`corrections[${i}].${what}`);
    const revise = c?.action === "revise";
    const keys = revise
      ? ["storyId", "action", "reasons", "note", "evidence", "text"]
      : ["storyId", "action", "reasons", "note", "evidence"];
    if (!hasExactly(c, keys)) return at("fields");
    if (!["revise", "exclude"].includes(c.action)) at("action");
    if (typeof c.storyId !== "string" || !STORY_ID.test(c.storyId))
      at("storyId");
    else if (seen.has(c.storyId)) at("storyId (duplicate)");
    seen.add(c.storyId);
    const allowed = CORRECTION_REASONS[c.action] ?? [];
    if (
      !Array.isArray(c.reasons) ||
      c.reasons.length === 0 ||
      new Set(c.reasons).size !== c.reasons.length ||
      !c.reasons.every((r) => allowed.includes(r))
    )
      at("reasons");
    if (!safeText(c.note, MAX_NOTE_CHARS)) at("note");
    if (
      !Array.isArray(c.evidence) ||
      c.evidence.length > MAX_EVIDENCE ||
      !c.evidence.every(
        (e) =>
          hasExactly(e, ["url", "quote"]) &&
          isSafeHttpsUrl(e.url) &&
          safeText(e.quote, MAX_QUOTE_CHARS) &&
          e.quote.trim().length >= 12,
      )
    )
      at("evidence");
    else if (revise && c.evidence.length === 0)
      at("evidence (a revision needs at least one quote)");
    if (!revise) return;
    const t = c.text;
    if (!hasExactly(t, ["en", "fr"])) return at("text");
    for (const lang of ["en", "fr"]) {
      const fields = isObject(t[lang]) ? Object.keys(t[lang]) : [];
      if (
        fields.length === 0 ||
        !fields.every((f) => TEXT_FIELDS.includes(f)) ||
        !fields.every((f) => safeText(t[lang][f], 700))
      )
        at(`text.${lang}`);
    }
    // English and French are revised together, field for field.
    const en = isObject(t.en) ? Object.keys(t.en).sort() : [];
    const fr = isObject(t.fr) ? Object.keys(t.fr).sort() : [];
    if (en.join() !== fr.join()) at("text (English and French fields differ)");
  });
  return problems;
}

/** Parses and checks a corrections document given as the exact file text. */
export function parseCorrections(text) {
  if (typeof text !== "string" || text.length === 0)
    fail("CORRECTIONS_INVALID", "The corrections document is empty");
  if (Buffer.byteLength(text, "utf8") > MAX_CORRECTIONS_BYTES)
    fail("CORRECTIONS_INVALID", "The corrections document is too large");
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    fail("CORRECTIONS_INVALID", "The corrections document is not JSON");
  }
  const problems = correctionProblems(doc);
  if (problems.length)
    fail("CORRECTIONS_INVALID", `Corrections: ${problems.join(", ")}`, {
      problems,
    });
  return doc;
}

/**
 * Applies a corrections document to an authenticated research draft.
 * `originalDigestOf(draft)` gives the content digest of the uncorrected public
 * edition (publish.mjs passes contentDigest of serializeEdition(publicEdition)).
 * `handoff` is the ledger handoff the bundle was opened with.
 * Returns { draft, excluded, record, review }; the input draft is not changed.
 */
export function applyCorrections({
  text,
  draft,
  report,
  handoff,
  originalDigestOf,
}) {
  const doc = parseCorrections(text);
  const basis = doc.basis;
  const mismatch = [];
  if (doc.edition !== draft?.edition) mismatch.push("edition");
  if (
    basis.researchRunId !== report?.runId ||
    basis.researchRunId !== handoff?.researchRunId
  )
    mismatch.push("researchRunId");
  for (const k of ["workflowRunId", "runAttempt", "artifactId", "bundleDigest"])
    if (basis[k] !== handoff?.[k]) mismatch.push(k);
  if (mismatch.length)
    fail(
      "CORRECTION_BASIS",
      `The corrections were written for other research (${mismatch.join(", ")})`,
    );
  const originalDigest = originalDigestOf(draft);
  if (basis.originalDigest !== originalDigest)
    fail(
      "CORRECTION_BASIS",
      "The corrections were written for different edition content (originalDigest)",
    );

  const byId = new Map(draft.stories.map((s) => [s.id, s]));
  const review = [];
  const revisions = new Map();
  const excluded = [];
  for (const c of doc.corrections) {
    const story = byId.get(c.storyId);
    if (!story)
      fail(
        "CORRECTION_UNKNOWN_STORY",
        `No story ${c.storyId} in edition ${draft.edition}`,
      );
    const entry = {
      storyId: c.storyId,
      action: c.action,
      reasons: [...c.reasons],
      note: c.note,
      evidence: c.evidence.map((e) => ({ url: e.url, quote: e.quote })),
      before: null,
      after: null,
    };
    if (c.action === "exclude") excluded.push(c.storyId);
    else {
      const before = { en: {}, fr: {} };
      const after = { en: {}, fr: {} };
      for (const lang of ["en", "fr"])
        for (const [field, value] of Object.entries(c.text[lang])) {
          if (value.trim() === story[lang]?.[field])
            fail(
              "CORRECTION_NOOP",
              `${c.storyId}.${lang}.${field} is unchanged`,
            );
          before[lang][field] = story[lang][field];
          after[lang][field] = value.trim();
        }
      entry.before = before;
      entry.after = after;
      revisions.set(c.storyId, after);
    }
    review.push(entry);
  }

  // A copy: the authenticated draft (and the bundle it came from) is untouched.
  const corrected = structuredClone(draft);
  corrected.stories = corrected.stories
    .filter((s) => !excluded.includes(s.id))
    .map((s) => {
      const after = revisions.get(s.id);
      if (after)
        for (const lang of ["en", "fr"]) Object.assign(s[lang], after[lang]);
      return s;
    });
  return {
    draft: corrected,
    excluded,
    review,
    record: {
      correctionsDigest: correctionsDigest(text),
      originalDigest,
      revised: [...revisions.keys()],
      excluded,
    },
  };
}

const numbersOf = (texts) => new Set(texts.flatMap((t) => extractNumbers(t)));

/**
 * After the Sunday source recheck: every cited quote must be on its live page
 * (the story's own article from the recheck, or another page fetched with the
 * same fetcher), revised text must not copy those pages, and numbers in
 * revised text must come from the original text, the story's article or the
 * quotes. `articles` maps story id -> fetchArticle result for the stories that
 * passed the recheck; `fetchArticle` fetches any other cited page.
 * Returns the list of problems (empty when supported).
 */
export async function verifyCorrectionSupport({
  applied,
  original,
  articles,
  fetchArticle,
}) {
  const problems = [];
  const pages = new Map();
  for (const [id, fetched] of Object.entries(articles))
    pages.set(original.stories.find((s) => s.id === id)?.url, fetched);
  const page = async (url) => {
    if (!pages.has(url)) pages.set(url, await fetchArticle(url));
    return pages.get(url);
  };
  for (const entry of applied.review) {
    const story = original.stories.find((s) => s.id === entry.storyId);
    const evidenceTexts = [];
    for (const [i, e] of entry.evidence.entries()) {
      const fetched = await page(e.url);
      if (!fetched?.ok) {
        problems.push(
          `CORRECTION_EVIDENCE_UNAVAILABLE:${entry.storyId}.evidence[${i}]`,
        );
        continue;
      }
      if (!containsQuote(fetched.article.text, e.quote))
        problems.push(
          `CORRECTION_QUOTE_NOT_FOUND:${entry.storyId}.evidence[${i}]`,
        );
      evidenceTexts.push(fetched.article.text);
    }
    if (entry.action !== "revise") continue;
    // A revised story dropped by the recheck is already out of the edition.
    const own = articles[entry.storyId];
    if (!own?.ok) continue;
    const known = numbersOf([
      ...TEXT_FIELDS.flatMap((f) => [story.en[f], story.fr[f]]),
      own.article.text,
      ...entry.evidence.map((e) => e.quote),
    ]);
    for (const lang of ["en", "fr"])
      for (const [field, value] of Object.entries(entry.after[lang])) {
        const unknown = extractNumbers(value).filter((n) => !known.has(n));
        if (unknown.length)
          problems.push(
            `CORRECTION_NUMBER_UNSUPPORTED:${entry.storyId}.${lang}.${field}`,
          );
        // The story's own article is checked by verifyAgainstArticle; other cited pages here.
        if (lang === "en" && field !== "headline")
          for (const text of evidenceTexts)
            if (text !== own.article.text && !checkCopyright(value, text).ok)
              problems.push(
                `CORRECTION_COPYRIGHT:${entry.storyId}.${lang}.${field}`,
              );
      }
  }
  return [...new Set(problems)];
}

/** Plain-text before/after rendering of the applied corrections, for editorial review. */
export function renderCorrections(record, review) {
  const lines = [
    `Corrections digest: ${record.correctionsDigest}`,
    `Uncorrected content digest: ${record.originalDigest}`,
    `Revised: ${record.revised.join(", ") || "none"}; excluded: ${record.excluded.join(", ") || "none"}`,
  ];
  for (const e of review) {
    lines.push(
      "",
      `--- ${e.action === "exclude" ? "EXCLUDED" : "REVISED"}: ${e.storyId} (${e.reasons.join(", ")}) ---`,
      `Note: ${e.note}`,
    );
    for (const ev of e.evidence)
      lines.push(`Evidence: ${ev.url}`, `  "${ev.quote}"`);
    if (e.action !== "revise") continue;
    for (const lang of ["en", "fr"])
      for (const field of Object.keys(e.after[lang]))
        lines.push(
          "",
          `[${lang.toUpperCase()}] ${field} BEFORE: ${e.before[lang][field]}`,
          `[${lang.toUpperCase()}] ${field} AFTER:  ${e.after[lang][field]}`,
        );
  }
  return lines.join("\n");
}

// CLI ------------------------------------------------------------------------------------------
// node scripts/tech-brief/corrections.mjs check --corrections FILE --review DIR --out DIR [--offline]
//
// Local editorial check, before the corrections go to the preview workflow.
// DIR is the folder written by `preview.mjs open` (editorial-preview-*.json).
// It binds the corrections to that preview's research identifiers and content,
// applies them to the public edition, runs the public-text checks (schema,
// bilingual consistency, editorial wording) and, unless --offline, fetches
// each source and cited page to check quotes, copyright and numbers. It writes
// a before/after review and the projected latest.json to --out (outside the
// repository) and prints identifiers, counts and digests only. Attribution and
// verification evidence are in the encrypted research bundle: only the
// preview workflow checks them, and only its preview can be approved.
// Exit 0 ok, 4 refused, 1 usage error.
// Not a top-level await: publish.mjs and preview.mjs import this module, so
// it must finish evaluating before the CLI imports them.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  cli();

async function cli() {
  const [command, ...args] = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? "") : null;
  };
  const out = (code, value) => {
    console.log(JSON.stringify(value));
    process.exit(code);
  };
  try {
    if (command !== "check")
      out(1, { ok: false, code: "USAGE", message: "Commands: check" });
    const { insideRepository } = await import("./preview.mjs");
    const { contentDigest, publicEdition, serializeEdition } =
      await import("./publish.mjs");
    const {
      checkBilingual,
      checkEditorial,
      checkSchema,
      loadSourcePolicy,
      verifyAgainstArticle,
    } = await import("./validate.mjs");
    const outDir = option("--out");
    if (!outDir || insideRepository(outDir))
      fail("USAGE", "--out is required and must be outside the repository");
    const reviewDir = option("--review") ?? "";
    const text = readFileSync(option("--corrections") ?? "", "utf8");
    const doc = parseCorrections(text);
    const payload = JSON.parse(
      readFileSync(
        join(reviewDir, `editorial-preview-${doc.edition}.json`),
        "utf8",
      ),
    );
    if (payload.dropped.length)
      fail(
        "CORRECTION_BASIS",
        "The preview dropped stories; check the corrections against a preview without drops",
      );
    const draft = JSON.parse(payload.publication);
    const digestOf = (d) => contentDigest(serializeEdition(publicEdition(d)));
    const applied = applyCorrections({
      text,
      draft,
      report: { runId: payload.source.researchRunId },
      handoff: payload.source,
      originalDigestOf: digestOf,
    });
    const problems = checkSchema(applied.draft).map(
      (e) => `${e.code} ${e.path}`,
    );
    applied.draft.stories.forEach((s, i) => {
      const path = `stories[${i}]`;
      for (const e of [
        ...checkBilingual(s, path).errors,
        ...checkEditorial(s, path),
      ])
        problems.push(`${e.code} ${e.path}`);
    });
    const warnings = [];
    if (!args.includes("--offline")) {
      const { createFetcher } = await import("./fetch.mjs");
      const policy = await loadSourcePolicy(
        new URL("./sources.json", import.meta.url),
      );
      const fetcher = createFetcher({ sourcePolicy: policy });
      const articles = {};
      for (const [i, s] of applied.draft.stories.entries()) {
        const fetched = await fetcher.fetchArticle(s.url);
        const check = verifyAgainstArticle(s, fetched, {
          path: `stories[${i}]`,
        });
        problems.push(...check.errors.map((e) => `${e.code} ${e.path}`));
        warnings.push(...check.warnings.map((w) => `${w.code} ${w.path}`));
        if (fetched?.ok) articles[s.id] = fetched;
      }
      problems.push(
        ...(await verifyCorrectionSupport({
          applied,
          original: draft,
          articles,
          fetchArticle: (url) => fetcher.fetchArticle(url),
        })),
      );
    }
    const projected = serializeEdition(publicEdition(applied.draft));
    mkdirSync(outDir, { recursive: true });
    const names = [
      `corrections-review-${doc.edition}.txt`,
      `latest-corrected-${doc.edition}.json`,
    ];
    for (const name of names)
      if (existsSync(join(outDir, name)))
        fail("OUTPUT_EXISTS", `${name} already exists in --out`);
    writeFileSync(
      join(outDir, names[0]),
      `${renderCorrections(applied.record, applied.review)}\n`,
      { flag: "wx" },
    );
    writeFileSync(join(outDir, names[1]), projected, { flag: "wx" });
    out(problems.length ? 4 : 0, {
      ok: problems.length === 0,
      command,
      edition: doc.edition,
      online: !args.includes("--offline"),
      revised: applied.record.revised,
      excluded: applied.record.excluded,
      stories: applied.draft.stories.length,
      categories: new Set(applied.draft.stories.map((s) => s.category)).size,
      problems,
      warnings: [...new Set(warnings)],
      correctionsDigest: applied.record.correctionsDigest,
      projectedContentDigest: contentDigest(projected),
      outDir: resolve(outDir),
      files: names,
    });
  } catch (error) {
    out(error?.code === "USAGE" ? 1 : 4, {
      ok: false,
      code: error?.code ?? "ERROR",
      message:
        error instanceof CorrectionError ? error.message : "Unexpected failure",
    });
  }
}
