// Phase 4: Sunday publication preparation.
//
// Input: a research result (report + draft edition) that bundle.mjs and
// provenance.mjs have already authenticated, held in memory. Output: the two
// public files the website reads, written only after every check passes:
//   <contentDir>/latest.json                  the edition the site renders
//   <contentDir>/editions/YYYY-MM-DD.json     the same edition, archived
// Both contain exactly the fields src/lib/techBrief.ts uses; verification
// quotes, claims, editorial evidence, generation and run metadata, costs and
// workflow identifiers never leave the research result.
//
// Checks, in order (any failure throws PublishError; nothing is written):
//  1. The source policy is approved (no override exists), the result is a
//     consistent production run made under an approved policy.
//  2. The published state is valid: latest.json is the empty placeholder or a
//     public edition identical to its archive copy, and editions/ holds only
//     valid public editions. An edition already live is reported as
//     "already-published"; an older one is refused.
//  3. Publication is due for this edition (schedule.mjs, Eastern time).
//  4. Every story's verification evidence matches the report: a verified
//     candidate, the main claim (c1) and at least minVerifiedClaims entailed
//     claims with their quotes.
//  5. validateEdition on the full research edition: schema, dates, duplicates
//     against the archive, source policy, bilingual parity, editorial wording
//     and vendor attribution.
//  6. Sunday source recheck through the injected fetcher (production uses
//     fetch.mjs with its SSRF, robots and source-policy safeguards): every
//     story's article is fetched again and must still match (verifyAgainstArticle)
//     and still contain each verified quote. Failed stories are dropped; the
//     rest must still meet the story count and category diversity, and the
//     reduced edition is validated again with the fetched articles.
//  7. The public projection has exactly the public shape and passes the
//     edition schema.
//
// Writing: both files are written to temporary files first, then renamed:
// the archive copy, then latest.json. An existing archive copy for the edition
// must be byte-identical (an interrupted earlier run) or the preparation is
// refused. latest.json must not have changed since it was read. If the second
// rename fails, the archive file created by this call is removed again.
//
// Boundary: this module never runs Git. The publication workflow commits the
// files it reports (and nothing else, verified with `git status`), pushes, and
// on any failure before the commit restores src/content/tech-brief from Git.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BundleError, checkResearchPair } from "./bundle.mjs";
import { stageDecision } from "./schedule.mjs";
import { containsQuote } from "./text.mjs";
import {
  checkSchema,
  loadHistory,
  validateEdition,
  verifyAgainstArticle,
} from "./validate.mjs";

export class PublishError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PublishError";
    this.code = code;
    this.details = details;
  }
}
const fail = (code, message, details) => {
  throw new PublishError(code, message, details);
};

const EDITION_FIELDS = ["schemaVersion", "edition", "publishedOn", "stories"];
const STORY_FIELDS = [
  "id",
  "category",
  "url",
  "publisher",
  "sourcePublishedOn",
  "sourceHeadline",
  "sourceHeadlineLang",
  "en",
  "fr",
];
const TEXT_FIELDS = ["headline", "summary", "whyItMatters"];
const ARCHIVE_NAME = /^\d{4}-\d{2}-\d{2}\.json$/;
const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const sameKeys = (value, keys) =>
  isObject(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((k) => Object.hasOwn(value, k));

/** The public edition: only the fields the website renders, in a fixed order. */
export function publicEdition(edition) {
  const text = (t) => Object.fromEntries(TEXT_FIELDS.map((k) => [k, t?.[k]]));
  return {
    schemaVersion: edition.schemaVersion,
    edition: edition.edition,
    publishedOn: edition.publishedOn,
    stories: edition.stories.map((s) => ({
      id: s.id,
      category: s.category,
      url: s.url,
      publisher: s.publisher,
      sourcePublishedOn: s.sourcePublishedOn,
      sourceHeadline: s.sourceHeadline,
      sourceHeadlineLang: s.sourceHeadlineLang,
      en: text(s.en),
      fr: text(s.fr),
    })),
  };
}

export const serializeEdition = (edition) =>
  `${JSON.stringify(edition, null, 2)}\n`;

/** Problems with a public edition: any field beyond the public shape, or a schema error. */
export function publicEditionProblems(value) {
  if (!sameKeys(value, EDITION_FIELDS)) return ["edition fields"];
  if (!Array.isArray(value.stories)) return ["stories"];
  const problems = [];
  value.stories.forEach((s, i) => {
    if (!sameKeys(s, STORY_FIELDS)) problems.push(`stories[${i}] fields`);
    else
      for (const lang of ["en", "fr"])
        if (!sameKeys(s[lang], TEXT_FIELDS))
          problems.push(`stories[${i}].${lang} fields`);
  });
  for (const e of checkSchema(value)) problems.push(`${e.code} ${e.path}`);
  return problems;
}

const EMPTY = {
  schemaVersion: 1,
  edition: null,
  publishedOn: null,
  stories: [],
};
const isPlaceholder = (v) =>
  sameKeys(v, EDITION_FIELDS) &&
  v.schemaVersion === 1 &&
  v.edition === null &&
  v.publishedOn === null &&
  Array.isArray(v.stories) &&
  v.stories.length === 0;

/**
 * Reads and validates what is currently published. Returns
 * { latestText, latestEdition (or null), archive: Map(edition -> text) }.
 */
export function readPublishedState(contentDir) {
  const invalid = (message) => fail("STATE_INVALID", message);
  const latestPath = join(contentDir, "latest.json");
  let latestText;
  try {
    latestText = readFileSync(latestPath, "utf8");
  } catch {
    invalid("latest.json cannot be read");
  }
  let latest;
  try {
    latest = JSON.parse(latestText);
  } catch {
    invalid("latest.json is not JSON");
  }
  const editionsDir = join(contentDir, "editions");
  const archive = new Map();
  if (existsSync(editionsDir)) {
    for (const name of readdirSync(editionsDir)) {
      const path = join(editionsDir, name);
      if (!ARCHIVE_NAME.test(name) || !statSync(path).isFile())
        invalid(`Unexpected entry in editions/: ${name}`);
      const text = readFileSync(path, "utf8");
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        invalid(`editions/${name} is not JSON`);
      }
      if (
        publicEditionProblems(value).length ||
        `${value.edition}.json` !== name
      )
        invalid(`editions/${name} is not a valid public edition`);
      archive.set(value.edition, text);
    }
  }
  if (isPlaceholder(latest))
    return { latestText, latestEdition: null, archive };
  if (publicEditionProblems(latest).length)
    invalid(
      "latest.json is neither the placeholder nor a valid public edition",
    );
  if (archive.get(latest.edition) !== latestText)
    invalid("latest.json differs from its archive copy");
  return { latestText, latestEdition: latest.edition, archive };
}

/** Whole-edition check that each story's verification evidence matches the report. */
function verificationProblems(report, draft, minClaims) {
  const problems = [];
  for (const story of draft.stories) {
    const candidate = report.candidates.find((c) => c?.storyId === story.id);
    const evidence = story.evidence?.verification;
    if (candidate?.verification?.status !== "verified") {
      problems.push(`${story.id}: not verified in the report`);
      continue;
    }
    if (!Array.isArray(evidence) || evidence.length < minClaims) {
      problems.push(`${story.id}: fewer than ${minClaims} verified claims`);
      continue;
    }
    if (!evidence.some((e) => e?.claimId === "c1"))
      problems.push(`${story.id}: main claim missing`);
    for (const e of evidence) {
      const claim = candidate.verification.claims?.find(
        (c) => c?.id === e?.claimId,
      );
      if (
        !claim ||
        claim.verdict !== "entailed" ||
        claim.quote !== e.quote ||
        typeof e.quote !== "string"
      )
        problems.push(
          `${story.id}: claim ${e?.claimId} is not an entailed report claim`,
        );
    }
    if ((candidate.verification.distinctSupported ?? 0) < minClaims)
      problems.push(`${story.id}: too few distinct supported claims`);
  }
  return problems;
}

function writeTemp(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
}
const removeQuietly = (path) => {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
};

/**
 * Prepares the public files for one authenticated research result. Returns
 * { status: "prepared" | "checked" | "already-published", edition, files,
 *   archiveCreated, dropped, warnings } or throws PublishError.
 * `rename` exists so tests can make the final file replacement fail.
 */
export async function preparePublication({
  report,
  draft,
  policy,
  config,
  fetcher,
  contentDir,
  now = new Date(),
  trigger = "schedule",
  write = true,
  rename = renameSync,
}) {
  // 1. Policy and research result.
  if (policy?.status !== "approved")
    fail(
      "POLICY_NOT_APPROVED",
      `Source policy is "${policy?.status ?? "unset"}"; publication requires an approved policy`,
    );
  let identity;
  try {
    identity = checkResearchPair(report, draft);
  } catch (error) {
    if (error instanceof BundleError)
      fail("INCONSISTENT_RESULT", `Research result: ${error.message}`);
    throw error;
  }
  if (identity.mode !== "production")
    fail("NOT_PRODUCTION", "Only production research can be published");
  if (
    draft.generation.policyStatus !== "approved" ||
    draft.generation.provisionalPolicyOverride !== false
  )
    fail(
      "POLICY_NOT_APPROVED",
      "The research ran without an approved source policy",
    );
  const { edition } = identity;

  // 2. Published state.
  const state = readPublishedState(contentDir);
  if (state.latestEdition === edition)
    return {
      status: "already-published",
      edition,
      files: [],
      archiveCreated: false,
      dropped: [],
      warnings: [],
    };
  if (state.latestEdition !== null && state.latestEdition > edition)
    fail(
      "SUPERSEDED",
      `Edition ${state.latestEdition} is already live; ${edition} is older`,
    );
  for (const archived of state.archive.keys())
    if (
      archived !== edition &&
      (state.latestEdition === null || archived > state.latestEdition)
    )
      fail(
        "STATE_INVALID",
        `editions/${archived}.json is newer than latest.json`,
      );

  // 3. Is publication due for this edition?
  const decision = stageDecision("publication", {
    now,
    trigger,
    edition: trigger === "manual" ? edition : null,
    publishedEdition: state.latestEdition,
  });
  if (!decision.due)
    fail("NOT_DUE", `${decision.code}: ${decision.reason}`, {
      decision: decision.code,
    });
  if (decision.edition !== edition)
    fail(
      "EDITION_MISMATCH",
      `Publication is due for ${decision.edition}, not ${edition}`,
    );

  // 4. Verification evidence.
  const minClaims = config.limits.minVerifiedClaims;
  const evidenceProblems = verificationProblems(report, draft, minClaims);
  if (evidenceProblems.length)
    fail("VERIFICATION_FAILED", evidenceProblems.join("; "));

  // 5. The full research edition.
  const editionsDir = join(contentDir, "editions");
  const history = await loadHistory(editionsDir, { beforeEdition: edition });
  const full = validateEdition(draft, { policy, now, history });
  if (!full.ok)
    fail(
      "VALIDATION_FAILED",
      full.errors.map((e) => `${e.code} ${e.path}`).join("; "),
      { codes: full.errors.map((e) => e.code) },
    );

  // 6. Sunday source recheck.
  const kept = [];
  const dropped = [];
  const articles = {};
  const warnings = new Set(full.warnings.map((w) => w.code));
  for (const [i, story] of draft.stories.entries()) {
    const fetched = await fetcher.fetchArticle(story.url);
    const reasons = [];
    if (!fetched?.ok)
      reasons.push(`SOURCE_UNAVAILABLE:${fetched?.code ?? "UNKNOWN"}`);
    else {
      const check = verifyAgainstArticle(story, fetched, {
        path: `stories[${i}]`,
      });
      reasons.push(...check.errors.map((e) => e.code));
      for (const w of check.warnings) warnings.add(w.code);
      for (const e of story.evidence.verification)
        if (!containsQuote(fetched.article.text, e.quote))
          reasons.push(`QUOTE_NOT_FOUND:${e.claimId}`);
    }
    if (reasons.length)
      dropped.push({ id: story.id, reasons: [...new Set(reasons)] });
    else {
      kept.push(story);
      articles[story.id] = fetched;
    }
  }
  if (kept.length < config.limits.minStories)
    fail(
      "INSUFFICIENT_STORIES",
      `${kept.length} stories passed the source recheck (need ${config.limits.minStories})`,
      { dropped },
    );
  if (new Set(kept.map((s) => s.category)).size < config.limits.minCategories)
    fail(
      "INSUFFICIENT_CATEGORIES",
      `The remaining stories cover fewer than ${config.limits.minCategories} categories`,
      { dropped },
    );
  const final = { ...draft, stories: kept };
  const recheck = validateEdition(final, { policy, now, history, articles });
  if (!recheck.ok)
    fail(
      "VALIDATION_FAILED",
      recheck.errors.map((e) => `${e.code} ${e.path}`).join("; "),
      { codes: recheck.errors.map((e) => e.code), dropped },
    );

  // 7. Public projection.
  const pub = publicEdition(final);
  const problems = publicEditionProblems(pub);
  if (problems.length) fail("PUBLIC_SCHEMA", problems.join("; "));
  const text = serializeEdition(pub);
  const result = {
    edition,
    files: ["latest.json", `editions/${edition}.json`],
    dropped,
    warnings: [...warnings].sort(),
  };
  if (!write)
    return { status: "checked", ...result, archiveCreated: false, text };

  // Writing.
  const archivePath = join(editionsDir, `${edition}.json`);
  const latestPath = join(contentDir, "latest.json");
  const existing = state.archive.get(edition);
  if (existing !== undefined && existing !== text)
    fail(
      "ARCHIVE_CONFLICT",
      `editions/${edition}.json exists with different content`,
    );
  if (readFileSync(latestPath, "utf8") !== state.latestText)
    fail("STATE_CHANGED", "latest.json changed during preparation");
  mkdirSync(editionsDir, { recursive: true });
  const archiveCreated = existing === undefined;
  const archiveTmp = archiveCreated ? writeTemp(archivePath, text) : null;
  let latestTmp = null;
  try {
    latestTmp = writeTemp(latestPath, text);
    if (archiveCreated) {
      if (existsSync(archivePath))
        fail(
          "ARCHIVE_CONFLICT",
          `editions/${edition}.json appeared during preparation`,
        );
      rename(archiveTmp, archivePath);
    }
    try {
      rename(latestTmp, latestPath);
    } catch (error) {
      if (archiveCreated) removeQuietly(archivePath);
      throw error;
    }
  } finally {
    if (archiveTmp) removeQuietly(archiveTmp);
    if (latestTmp) removeQuietly(latestTmp);
  }
  return { status: "prepared", ...result, archiveCreated };
}

// CLI ------------------------------------------------------------------------------------------
// node scripts/tech-brief/publish.mjs check [--content-dir DIR]
// Validates the published state (default src/content/tech-brief) without
// changing anything. Publication itself is a library call from the workflow,
// which holds the decrypted research result in memory only.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, ...args] = process.argv.slice(2);
  const i = args.indexOf("--content-dir");
  const contentDir =
    i >= 0
      ? args[i + 1]
      : fileURLToPath(
          new URL("../../src/content/tech-brief/", import.meta.url),
        );
  if (command !== "check") {
    console.log(
      JSON.stringify({ ok: false, code: "USAGE", message: "Commands: check" }),
    );
    process.exit(1);
  }
  try {
    const state = readPublishedState(contentDir);
    console.log(
      JSON.stringify({
        ok: true,
        latestEdition: state.latestEdition,
        archived: [...state.archive.keys()].sort(),
      }),
    );
    process.exit(0);
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        code: error instanceof PublishError ? error.code : "ERROR",
        message:
          error instanceof PublishError ? error.message : "Unexpected failure",
      }),
    );
    process.exit(4);
  }
}

export { EMPTY as EMPTY_EDITION };
