// Deterministic validation of Tech Brief editions (Phase 2).
//
// Checks structure, dates, duplicates, source policy, English/French
// consistency and editorial wording, and compares stories with fetched
// articles (headline, date, canonical URL, copyright overlap, hidden
// instructions). These checks cannot prove that a story's claims are
// accurate: a live link and a matching headline are necessary, not
// sufficient. Claim verification is Phase 3.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  UNSAFE_CHARS,
  extractNumbers,
  guessLanguage,
  headlineSimilarity,
  normalizeForMatch,
  sharedRuns,
  tokenizeKeepCase,
  topicSimilarity,
  wordCount,
} from "./text.mjs";
import { checkAttribution } from "./editorial.mjs";
import { findInjectionSignals } from "./html.mjs";

export const CATEGORIES = [
  "emerging-technology",
  "development-practices",
  "tools-techniques",
  "applied-ai",
];
export const TIME_ZONE = "America/New_York";

// Character caps match src/lib/techBrief.ts exactly (the site rejects anything longer).
export const LIMITS = Object.freeze({
  minStories: 3,
  maxStories: 5,
  urlChars: 2048,
  headlineChars: 200,
  summaryChars: 700,
  whyChars: 500,
  publisherChars: 100,
  // Editorial word caps (stricter than the site's character caps). French runs
  // about 15-20% longer than English, so its caps are higher.
  words: {
    en: { summary: 70, whyItMatters: 50 },
    fr: { summary: 85, whyItMatters: 60 },
  },
  windowDays: 7,
});

// Copyright-overlap thresholds, calibrated on test/fixtures/copyright-cases.json
// (see test/copyright.test.mjs). A text fails if it shares with the source:
// - any run of `maxRun` or more consecutive words, or
// - more than `maxRuns` separate runs of at least `minRun` words (patchwriting), or
// - runs of at least `minRun` words covering more than `maxCoverage` of its words.
// Runs that are proper names or official titles are exempt.
// PROVISIONAL: calibrated on 17 hand-written cases only. Phase 3 must
// re-evaluate these thresholds against actual AI-generated summaries before
// they are relied on in production.
export const COPYRIGHT = Object.freeze({
  maxRun: 12,
  minRun: 8,
  maxRuns: 1,
  maxCoverage: 0.5,
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LANG_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const STORY_ID = /^[a-z0-9-]{1,40}$/;

// Sensational or promotional wording that the editorial line excludes.
const BANNED_PHRASES = {
  en: [
    "revolutionary",
    "revolutionize",
    "game-changer",
    "game changer",
    "game-changing",
    "groundbreaking",
    "ground-breaking",
    "mind-blowing",
    "jaw-dropping",
    "unprecedented",
    "must-have",
    "must-see",
    "best-in-class",
    "world-class",
    "cutting-edge",
    "skyrocket",
    "insane",
    "magic bullet",
    "silver bullet",
    "will replace",
    "will revolutionize",
    "will transform",
    "disrupt everything",
    "you won't believe",
  ],
  fr: [
    "révolutionnaire",
    "révolutionner",
    "changer la donne",
    "change la donne",
    "incontournable",
    "sans précédent",
    "époustouflant",
    "à couper le souffle",
    "va remplacer",
    "vont remplacer",
    "va révolutionner",
    "solution miracle",
    "de pointe",
    "percée majeure",
  ],
};

const issue = (code, path, message) => ({ code, path, message });

function isText(value, max) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value === value.trim() &&
    !UNSAFE_CHARS.test(value)
  );
}

function isIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export function isSafeHttpsUrl(value) {
  if (
    typeof value !== "string" ||
    value.length > LIMITS.urlChars ||
    UNSAFE_CHARS.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

// --- structure ----------------------------------------------------------------

/** Structural checks. Accepts exactly what the site's parseEdition accepts. */
export function checkSchema(edition) {
  const errors = [];
  if (typeof edition !== "object" || edition === null || Array.isArray(edition))
    return [issue("SCHEMA", "", "Edition must be an object")];
  if (edition.schemaVersion !== 1)
    errors.push(issue("SCHEMA", "schemaVersion", "schemaVersion must be 1"));
  if (!isIsoDate(edition.edition))
    errors.push(
      issue("SCHEMA", "edition", "edition must be a real YYYY-MM-DD date"),
    );
  if (!isIsoDate(edition.publishedOn))
    errors.push(
      issue(
        "SCHEMA",
        "publishedOn",
        "publishedOn must be a real YYYY-MM-DD date",
      ),
    );
  if (!Array.isArray(edition.stories))
    return [...errors, issue("SCHEMA", "stories", "stories must be an array")];
  if (
    edition.stories.length < LIMITS.minStories ||
    edition.stories.length > LIMITS.maxStories
  ) {
    errors.push(
      issue(
        "SCHEMA",
        "stories",
        `Expected ${LIMITS.minStories}-${LIMITS.maxStories} stories, got ${edition.stories.length}`,
      ),
    );
  }
  const ids = new Set();
  edition.stories.forEach((story, i) => {
    const at = (field) => `stories[${i}]${field ? `.${field}` : ""}`;
    if (typeof story !== "object" || story === null || Array.isArray(story)) {
      errors.push(issue("SCHEMA", at(), "Story must be an object"));
      return;
    }
    if (typeof story.id !== "string" || !STORY_ID.test(story.id))
      errors.push(issue("SCHEMA", at("id"), "id must match [a-z0-9-]{1,40}"));
    else if (ids.has(story.id))
      errors.push(issue("SCHEMA", at("id"), `Duplicate id ${story.id}`));
    else ids.add(story.id);
    if (!CATEGORIES.includes(story.category))
      errors.push(
        issue(
          "SCHEMA",
          at("category"),
          `Unknown category ${JSON.stringify(story.category)}`,
        ),
      );
    if (!isSafeHttpsUrl(story.url))
      errors.push(
        issue(
          "SCHEMA",
          at("url"),
          "url must be https, without credentials, at most 2048 characters",
        ),
      );
    if (!isText(story.publisher, LIMITS.publisherChars))
      errors.push(
        issue(
          "SCHEMA",
          at("publisher"),
          "publisher is missing, padded, too long or has unsafe characters",
        ),
      );
    if (!isIsoDate(story.sourcePublishedOn))
      errors.push(
        issue(
          "SCHEMA",
          at("sourcePublishedOn"),
          "sourcePublishedOn must be a real YYYY-MM-DD date",
        ),
      );
    if (!isText(story.sourceHeadline, LIMITS.headlineChars))
      errors.push(
        issue(
          "SCHEMA",
          at("sourceHeadline"),
          "sourceHeadline is missing, padded, too long or has unsafe characters",
        ),
      );
    if (
      typeof story.sourceHeadlineLang !== "string" ||
      !LANG_TAG.test(story.sourceHeadlineLang)
    )
      errors.push(
        issue(
          "SCHEMA",
          at("sourceHeadlineLang"),
          "sourceHeadlineLang must be a language tag such as en or fr",
        ),
      );
    for (const lang of ["en", "fr"]) {
      const text = story[lang];
      if (typeof text !== "object" || text === null || Array.isArray(text)) {
        errors.push(issue("SCHEMA", at(lang), `${lang} text block is missing`));
        continue;
      }
      if (!isText(text.headline, LIMITS.headlineChars))
        errors.push(
          issue(
            "SCHEMA",
            at(`${lang}.headline`),
            "headline is missing, padded, too long or has unsafe characters",
          ),
        );
      if (!isText(text.summary, LIMITS.summaryChars))
        errors.push(
          issue(
            "SCHEMA",
            at(`${lang}.summary`),
            "summary is missing, padded, too long or has unsafe characters",
          ),
        );
      if (!isText(text.whyItMatters, LIMITS.whyChars))
        errors.push(
          issue(
            "SCHEMA",
            at(`${lang}.whyItMatters`),
            "whyItMatters is missing, padded, too long or has unsafe characters",
          ),
        );
    }
  });
  return errors;
}

// --- dates (America/New_York, DST-aware) --------------------------------------

function zoneOffsetMinutes(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour,
    +parts.minute,
    +parts.second,
  );
  return (asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}

/** UTC instant for a wall-clock time in a time zone (handles DST). */
export function zonedTimeToUtc(isoDate, hour, minute, timeZone = TIME_ZONE) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const first = zoneOffsetMinutes(new Date(guess), timeZone);
  let instant = guess - first * 60000;
  const second = zoneOffsetMinutes(new Date(instant), timeZone);
  if (second !== first) instant = guess - second * 60000;
  return new Date(instant);
}

/** Calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function dateInZone(date, timeZone = TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The research window for an edition: the 7 days ending Saturday 20:00 Eastern. */
export function editionWindow(edition) {
  return {
    cutoff: zonedTimeToUtc(edition, 20, 0),
    firstDate: addDays(edition, -LIMITS.windowDays),
    lastDate: edition,
  };
}

/**
 * Calendar dates an instant can legitimately be reported as: the date in the
 * offset the source wrote, in UTC, and in Eastern time. Two dates "agree" when
 * these sets intersect, i.e. when the difference is explained by time zones.
 */
function instantDates(instant, offsetMinutes) {
  const dates = [dateInZone(instant), instant.toISOString().slice(0, 10)];
  if (offsetMinutes !== null) {
    const local = new Date(instant.getTime() + offsetMinutes * 60000);
    dates.push(local.toISOString().slice(0, 10));
  }
  return [...new Set(dates)];
}

function writtenOffsetMinutes(text) {
  if (/(?:Z|\b(?:GMT|UTC))$/i.test(text)) return 0;
  const m = text.match(/([+-])(\d{2}):?(\d{2})$/);
  return m
    ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
    : null;
}

/**
 * Parses a metadata date into { date (Eastern calendar day), instant|null,
 * dates (every time-zone-consistent calendar day) }, or null if unusable.
 */
export function parseSourceDate(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (ISO_DATE.test(text))
    return isIsoDate(text)
      ? { date: text, instant: null, dates: [text] }
      : null;
  // ISO 8601 with time must carry an offset or Z; otherwise the day is ambiguous.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    const written = text.slice(0, 10);
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text))
      return isIsoDate(written)
        ? { date: written, instant: null, dates: [written], ambiguous: true }
        : null;
    const instant = new Date(text);
    return Number.isNaN(instant.getTime())
      ? null
      : {
          date: dateInZone(instant),
          instant,
          dates: instantDates(instant, writtenOffsetMinutes(text)),
        };
  }
  // RFC 2822 style ("Tue, 20 Oct 2026 14:00:00 GMT") with an explicit zone.
  if (/\b\d{4}\b/.test(text) && /\b(?:GMT|UTC|[+-]\d{4})\b/.test(text)) {
    const instant = new Date(text);
    return Number.isNaN(instant.getTime())
      ? null
      : {
          date: dateInZone(instant),
          instant,
          dates: instantDates(instant, writtenOffsetMinutes(text)),
        };
  }
  return null;
}

export function checkDates(edition, { now = new Date() } = {}) {
  const errors = [];
  if (!isIsoDate(edition.edition) || !isIsoDate(edition.publishedOn))
    return errors; // reported by checkSchema
  if (new Date(`${edition.edition}T00:00:00Z`).getUTCDay() !== 6)
    errors.push(issue("DATE", "edition", "edition must be a Saturday"));
  if (edition.publishedOn !== addDays(edition.edition, 1))
    errors.push(
      issue(
        "DATE",
        "publishedOn",
        "publishedOn must be the Sunday after the edition date",
      ),
    );
  const window = editionWindow(edition.edition);
  const today = dateInZone(now);
  (edition.stories ?? []).forEach((story, i) => {
    const d = story?.sourcePublishedOn;
    if (!isIsoDate(d)) return;
    if (d < window.firstDate || d > window.lastDate) {
      errors.push(
        issue(
          "DATE_WINDOW",
          `stories[${i}].sourcePublishedOn`,
          `${d} is outside the window ${window.firstDate}..${window.lastDate}`,
        ),
      );
    }
    if (d > today)
      errors.push(
        issue(
          "DATE_FUTURE",
          `stories[${i}].sourcePublishedOn`,
          `${d} is in the future`,
        ),
      );
  });
  return errors;
}

// --- sites ----------------------------------------------------------------------

// Second-level labels that, under a two-letter country TLD, are part of the
// public suffix (co.uk, com.au, gouv.fr ...). An approximation of the Public
// Suffix List: unknown cases are treated as different sites (fail closed).
const GENERIC_SLDS = new Set([
  "co",
  "com",
  "net",
  "org",
  "gov",
  "gouv",
  "edu",
  "ac",
  "or",
  "ne",
  "go",
  "mil",
  "nic",
  "ltd",
  "plc",
  "asso",
]);
// Shared hosting platforms where each subdomain belongs to a different owner.
const SHARED_HOSTS = [
  "github.io",
  "gitlab.io",
  "blogspot.com",
  "wordpress.com",
  "medium.com",
  "substack.com",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "herokuapp.com",
  "azurewebsites.net",
  "cloudfront.net",
  "amazonaws.com",
  "web.app",
  "firebaseapp.com",
  "notion.site",
  "ghost.io",
];

/** Approximate registrable domain ("site") of a hostname. */
export function siteOf(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const shared = SHARED_HOSTS.find((s) => host === s || host.endsWith(`.${s}`));
  const labels = host.split(".");
  if (shared) return labels.slice(-(shared.split(".").length + 1)).join(".");
  const [sld, tld] = labels.slice(-2);
  const keep = tld.length === 2 && GENERIC_SLDS.has(sld) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

export function sameSite(a, b) {
  return siteOf(new URL(a).hostname) === siteOf(new URL(b).hostname);
}

// --- duplicates ------------------------------------------------------------------

const TRACKING_PARAMS =
  /^(?:utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref|ref_src|cmpid|ocid|igshid|_hsenc|_hsmi|mkt_tok)$/i;

/** URL form used for duplicate detection (no www, fragment, tracking params or trailing slash). */
export function normalizeUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  const params = [...url.searchParams]
    .filter(([key]) => !TRACKING_PARAMS.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = new URLSearchParams(params).toString();
  url.pathname =
    url.pathname.replace(/\/index\.(?:html?|php)$/i, "/").replace(/\/+$/, "") ||
    "/";
  return url.href;
}

/**
 * Exact (normalized URL) and near (similar headline/topic) duplicates within the
 * edition and against recent history ({ url, headline, edition }[]).
 */
export function checkDuplicates(
  stories,
  { history = [], similarity = 0.6 } = {},
) {
  const errors = [];
  const seen = [];
  const safeNormalize = (u) => {
    try {
      return normalizeUrl(u);
    } catch {
      return null;
    }
  };
  stories.forEach((story, i) => {
    const url = safeNormalize(story.url);
    const headline = story.sourceHeadline ?? "";
    const topic = `${headline} ${story.en?.headline ?? ""}`;
    for (const other of seen) {
      if (url && url === other.url)
        errors.push(
          issue(
            "DUPLICATE_URL",
            `stories[${i}].url`,
            `Same article as stories[${other.index}]`,
          ),
        );
      else if (topicSimilarity(topic, other.topic) >= similarity)
        errors.push(
          issue(
            "DUPLICATE_TOPIC",
            `stories[${i}]`,
            `Too similar to stories[${other.index}] (likely the same event)`,
          ),
        );
    }
    for (const past of history) {
      if (url && url === safeNormalize(past.url))
        errors.push(
          issue(
            "REPEAT_URL",
            `stories[${i}].url`,
            `Already published in edition ${past.edition}`,
          ),
        );
      else if (topicSimilarity(topic, past.headline ?? "") >= similarity)
        errors.push(
          issue(
            "REPEAT_TOPIC",
            `stories[${i}]`,
            `Very similar to a story published in edition ${past.edition}`,
          ),
        );
    }
    seen.push({ index: i, url, topic });
  });
  return errors;
}

/** Loads { url, headline, edition } from earlier edition files in a directory. */
export async function loadHistory(dir, { beforeEdition, weeks = 8 } = {}) {
  let names = [];
  try {
    names = (await readdir(dir)).filter((n) =>
      /^\d{4}-\d{2}-\d{2}\.json$/.test(n),
    );
  } catch {
    return [];
  }
  const earliest = beforeEdition
    ? addDays(beforeEdition, -7 * weeks)
    : "0000-00-00";
  const history = [];
  for (const name of names) {
    const edition = name.slice(0, 10);
    if (edition < earliest || (beforeEdition && edition >= beforeEdition))
      continue;
    try {
      const data = JSON.parse(await readFile(join(dir, name), "utf8"));
      for (const s of data.stories ?? [])
        history.push({
          url: s.url,
          headline: `${s.sourceHeadline ?? ""} ${s.en?.headline ?? ""}`,
          edition,
        });
    } catch {
      // An unreadable archive file is skipped; it cannot cause publication.
    }
  }
  return history;
}

// --- source policy -----------------------------------------------------------------

export async function loadSourcePolicy(path) {
  const policy = JSON.parse(await readFile(path, "utf8"));
  const problems = validateSourcePolicy(policy);
  if (problems.length)
    throw new Error(`Invalid source policy: ${problems.join("; ")}`);
  return policy;
}

export function validateSourcePolicy(policy) {
  const problems = [];
  if (policy?.version !== 1) problems.push("version must be 1");
  if (!["denylist", "allowlist"].includes(policy?.mode))
    problems.push('mode must be "denylist" or "allowlist"');
  const seen = new Map();
  for (const list of ["preferred", "reviewRequired", "excluded"]) {
    if (!Array.isArray(policy?.[list])) {
      problems.push(`${list} must be an array`);
      continue;
    }
    policy[list].forEach((entry, i) => {
      if (
        typeof entry?.domain !== "string" ||
        !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(entry.domain)
      )
        problems.push(`${list}[${i}].domain is invalid`);
      else if (seen.has(entry.domain))
        problems.push(
          `${entry.domain} is listed twice (${seen.get(entry.domain)} and ${list})`,
        );
      else seen.set(entry.domain, list);
    });
  }
  return problems;
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Source status for a URL: "excluded", "review", "preferred" (with tier) or
 * "allowed" (denylist mode only). In allowlist mode unknown sources are excluded.
 */
export function evaluateSource(rawUrl, policy) {
  let host;
  try {
    host = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.$/, "");
  } catch {
    return { status: "excluded", reason: "invalid URL" };
  }
  const find = (list) =>
    (policy[list] ?? [])
      .filter((e) => hostMatches(host, e.domain))
      .sort((a, b) => b.domain.length - a.domain.length)[0];
  const excluded = find("excluded");
  if (excluded)
    return {
      status: "excluded",
      domain: excluded.domain,
      reason: excluded.reason ?? "excluded source",
    };
  const review = find("reviewRequired");
  if (review)
    return {
      status: "review",
      domain: review.domain,
      reason: review.reason ?? "requires editorial review",
    };
  const preferred = find("preferred");
  if (preferred)
    return {
      status: "preferred",
      domain: preferred.domain,
      tier: preferred.tier ?? 2,
      kind: preferred.kind,
    };
  if (policy.mode === "allowlist")
    return { status: "excluded", reason: "not on the allowlist" };
  return { status: "allowed", tier: 3 };
}

export function checkSourcePolicy(
  stories,
  policy,
  { allowReview = false } = {},
) {
  const errors = [];
  const perSite = new Map();
  stories.forEach((story, i) => {
    if (!isSafeHttpsUrl(story.url)) return;
    const verdict = evaluateSource(story.url, policy);
    if (verdict.status === "excluded")
      errors.push(
        issue("SOURCE_EXCLUDED", `stories[${i}].url`, verdict.reason),
      );
    if (verdict.status === "review" && !allowReview)
      errors.push(
        issue(
          "SOURCE_REVIEW",
          `stories[${i}].url`,
          `${verdict.domain}: ${verdict.reason}`,
        ),
      );
    const host = new URL(story.url).hostname.replace(/^www\./, "");
    perSite.set(host, (perSite.get(host) ?? 0) + 1);
  });
  const max = policy.limits?.maxStoriesPerDomain ?? 1;
  for (const [host, count] of perSite)
    if (count > max)
      errors.push(
        issue(
          "SOURCE_CONCENTRATION",
          "stories",
          `${count} stories from ${host} (max ${max})`,
        ),
      );
  return errors;
}

// --- English / French consistency and editorial wording ------------------------------

const sameMultiset = (a, b) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export function checkBilingual(story, path = "story") {
  const errors = [];
  const warnings = [];
  const en = story.en ?? {};
  const fr = story.fr ?? {};
  for (const field of ["headline", "summary", "whyItMatters"]) {
    if (
      typeof en[field] === "string" &&
      en[field] &&
      normalizeForMatch(en[field]) === normalizeForMatch(fr[field] ?? "")
    ) {
      errors.push(
        issue(
          "FR_UNTRANSLATED",
          `${path}.fr.${field}`,
          "French text is identical to English",
        ),
      );
    }
  }
  const enProse = `${en.summary ?? ""} ${en.whyItMatters ?? ""}`;
  const frProse = `${fr.summary ?? ""} ${fr.whyItMatters ?? ""}`;
  if (guessLanguage(frProse) !== "fr")
    errors.push(
      issue("FR_LANGUAGE", `${path}.fr`, "French text does not read as French"),
    );
  if (guessLanguage(enProse) !== "en")
    errors.push(
      issue(
        "EN_LANGUAGE",
        `${path}.en`,
        "English text does not read as English",
      ),
    );
  for (const field of ["headline", "summary", "whyItMatters"]) {
    const a = extractNumbers(en[field] ?? "");
    const b = extractNumbers(fr[field] ?? "");
    if (!sameMultiset(a, b))
      errors.push(
        issue(
          "NUMBER_MISMATCH",
          `${path}.${field}`,
          `Numbers differ: EN [${a.join(", ")}] vs FR [${b.join(", ")}]`,
        ),
      );
  }
  for (const lang of ["en", "fr"]) {
    for (const field of ["summary", "whyItMatters"]) {
      const text = story[lang]?.[field];
      if (typeof text !== "string") continue;
      const words = wordCount(text);
      const cap = LIMITS.words[lang][field];
      if (words > cap)
        errors.push(
          issue(
            "TOO_LONG",
            `${path}.${lang}.${field}`,
            `${words} words (max ${cap})`,
          ),
        );
    }
  }
  // Product and organization names (capitalized words after the first) should survive translation.
  const names =
    (en.summary ?? "").match(
      /(?<=\s)[A-Z][\w-]*[A-Z0-9][\w-]*|(?<=\s)[A-Z][a-z]+[A-Z][\w-]*/g,
    ) ?? [];
  for (const name of new Set(names))
    if (!(fr.summary ?? "").includes(name))
      warnings.push(
        issue(
          "NAME_MISSING_FR",
          `${path}.fr.summary`,
          `"${name}" not found in French summary`,
        ),
      );
  return { errors, warnings };
}

export function checkEditorial(story, path = "story") {
  const errors = [];
  for (const lang of ["en", "fr"]) {
    for (const field of ["headline", "summary", "whyItMatters"]) {
      const text = normalizeForMatch(story[lang]?.[field] ?? "");
      for (const phrase of BANNED_PHRASES[lang]) {
        const p = normalizeForMatch(phrase);
        if (
          new RegExp(
            `(?:^|[^\\p{L}])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}])`,
            "u",
          ).test(text)
        ) {
          errors.push(
            issue(
              "EDITORIAL_WORDING",
              `${path}.${lang}.${field}`,
              `Avoid "${phrase}"`,
            ),
          );
        }
      }
      const signals = findInjectionSignals(story[lang]?.[field] ?? "");
      if (signals.length)
        errors.push(
          issue(
            "INSTRUCTION_TEXT",
            `${path}.${lang}.${field}`,
            `Instruction-like text: ${signals[0]}`,
          ),
        );
    }
  }
  return errors;
}

// --- comparison with the fetched article ---------------------------------------------------

const NAME_CONNECTORS = new Set([
  "for",
  "of",
  "and",
  "the",
  "on",
  "in",
  "to",
  "a",
  "an",
  "de",
  "du",
  "des",
  "la",
  "le",
  "les",
  "et",
  "d",
  "l",
  "pour",
  "sur",
]);

/** True when a run of words is a proper name or title (e.g. an official programme name). */
function isNameSpan(words) {
  const content = words.filter((w) => !NAME_CONNECTORS.has(w.toLowerCase()));
  if (content.length === 0) return false;
  const named = content.filter((w) => /^[\p{Lu}\p{N}]/u.test(w));
  return named.length === content.length;
}

/**
 * Copyright check against the source text: fails on a long verbatim run or
 * heavy verbatim coverage. Shared runs that are proper names or official
 * titles (every content word capitalized) are exempt, because names are
 * facts that a summary has to repeat.
 */
export function checkCopyright(text, sourceText, thresholds = COPYRIGHT) {
  const { longest, runs, tokens } = sharedRuns(
    text,
    sourceText,
    thresholds.minRun,
  );
  const raw = tokenizeKeepCase(text);
  const counted = runs.filter(
    (r) => !isNameSpan(raw.slice(r.start, r.start + r.length)),
  );
  const covered = new Uint8Array(tokens);
  counted.forEach((r) => covered.fill(1, r.start, r.start + r.length));
  const coverage = tokens ? covered.reduce((sum, v) => sum + v, 0) / tokens : 0;
  // Separate copied passages = contiguous covered segments (overlapping matches merge).
  const segments = covered.reduce(
    (count, v, i) => count + (v && !covered[i - 1] ? 1 : 0),
    0,
  );
  const longestCounted = counted.reduce((max, r) => Math.max(max, r.length), 0);
  const ok =
    longestCounted < thresholds.maxRun &&
    segments <= thresholds.maxRuns &&
    coverage <= thresholds.maxCoverage;
  return {
    ok,
    longest,
    longestCounted,
    segments,
    coverage: Math.round(coverage * 1000) / 1000,
    runs: [...new Set(counted.map((r) => r.words))],
    exemptNames: [
      ...new Set(runs.filter((r) => !counted.includes(r)).map((r) => r.words)),
    ],
  };
}

export function bestHeadlineMatch(expected, article) {
  const candidates = [
    ["jsonLdHeadline", article.jsonLdHeadline],
    ["ogTitle", article.ogTitle],
    ["twitterTitle", article.twitterTitle],
    ["h1", article.h1],
    ["title", article.titleWithoutSite],
    ["rawTitle", article.title],
  ].filter(([, v]) => v);
  let best = { field: null, score: 0, value: "" };
  for (const [field, value] of candidates) {
    const score = headlineSimilarity(expected, value);
    if (score > best.score) best = { field, score, value };
  }
  return best;
}

const MONTHS = {
  jan: 1,
  january: 1,
  janvier: 1,
  feb: 2,
  february: 2,
  fevrier: 2,
  mar: 3,
  march: 3,
  mars: 3,
  apr: 4,
  april: 4,
  avril: 4,
  may: 5,
  mai: 5,
  jun: 6,
  june: 6,
  juin: 6,
  jul: 7,
  july: 7,
  juillet: 7,
  aug: 8,
  august: 8,
  aout: 8,
  sep: 9,
  sept: 9,
  september: 9,
  septembre: 9,
  oct: 10,
  october: 10,
  octobre: 10,
  nov: 11,
  november: 11,
  novembre: 11,
  dec: 12,
  december: 12,
  decembre: 12,
};

// Wording that marks a visible date as an update or revision, not publication
// (matched after normalizeForMatch, so French accents are already folded).
export const UPDATE_WORDING =
  /\b(?:updated|modified|revised|last edited|edited on|mis a jour|mise a jour|modifie|actualise)\b/;

/** Parses a visible date such as "Oct. 15, 2026", "15 October 2026" or "1er octobre 2026". */
export function parseTextDate(value) {
  if (typeof value !== "string") return null;
  const text = normalizeForMatch(value);
  if (UPDATE_WORDING.test(text)) return null;
  if (ISO_DATE.test(text))
    return isIsoDate(text)
      ? { date: text, instant: null, dates: [text] }
      : null;
  const month = "([a-z]{3,9})\\.?";
  const patterns = [
    [
      new RegExp(`\\b${month}\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b`),
      (m) => [m[3], m[1], m[2]],
    ],
    [
      new RegExp(`\\b(\\d{1,2})(?:er)?\\s+${month}\\s+(20\\d{2})\\b`),
      (m) => [m[3], m[2], m[1]],
    ],
  ];
  for (const [re, order] of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const [year, monthName, day] = order(m);
    const monthNumber = MONTHS[monthName];
    if (!monthNumber) continue;
    const iso = `${year}-${String(monthNumber).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (isIsoDate(iso)) return { date: iso, instant: null, dates: [iso] };
  }
  return null;
}

const datesAgree = (a, b) =>
  a.parsed.dates.some((d) => b.parsed.dates.includes(d));

/**
 * Picks the publication date. Evidence, in order of preference: article
 * metadata, then a clearly labelled visible publication date. A /YYYY/MM/DD/
 * URL path is never sufficient on its own; it is only compared. Dates that
 * disagree beyond what time zones explain are returned as conflicts.
 */
export function resolvePublishedDate(article) {
  const parsed = article.dateCandidates
    .map((c) => ({
      ...c,
      parsed: c.weak ? parseTextDate(c.value) : parseSourceDate(c.value),
    }))
    .filter((c) => c.parsed);
  const urlDates = parsed.filter((c) => c.source === "url.path");
  const evidence = parsed.filter((c) => c.source !== "url.path");
  if (evidence.length === 0) {
    return {
      date: null,
      dates: [],
      conflicts: [],
      urlMismatch: [],
      urlOnly: urlDates.length > 0,
    };
  }
  const strong = evidence.filter((c) => !c.weak);
  const primary =
    strong.find((c) => !c.parsed.ambiguous) ?? strong[0] ?? evidence[0];
  const describe = (c) => `${c.source}=${c.value}`;
  return {
    date: primary.parsed.date,
    dates: primary.parsed.dates,
    source: primary.source,
    weak: Boolean(primary.weak),
    ambiguous: Boolean(primary.parsed.ambiguous),
    conflicts: evidence
      .filter((c) => c !== primary && !datesAgree(c, primary))
      .map(describe),
    urlMismatch: urlDates.filter((c) => !datesAgree(c, primary)).map(describe),
  };
}

/**
 * Compares a story with its fetched article (output of fetch.mjs fetchArticle).
 * Errors block publication; warnings are recorded for review.
 */
export function verifyAgainstArticle(
  story,
  fetched,
  { path = "story", headlineThreshold = 0.8 } = {},
) {
  const errors = [];
  const warnings = [];
  if (!fetched?.ok)
    return {
      errors: [
        issue(
          "SOURCE_UNAVAILABLE",
          `${path}.url`,
          `${fetched?.code ?? "UNKNOWN"}: ${fetched?.message ?? "not fetched"}`,
        ),
      ],
      warnings,
    };
  const article = fetched.article;

  // The published URL must be the page we read (after redirects) or its canonical.
  const finalUrl = normalizeUrl(fetched.finalUrl);
  const storyUrl = normalizeUrl(story.url);
  let canonical = null;
  try {
    canonical = article.canonicalUrl
      ? normalizeUrl(new URL(article.canonicalUrl, fetched.finalUrl).href)
      : null;
  } catch {
    warnings.push(
      issue(
        "CANONICAL_INVALID",
        `${path}.url`,
        "Canonical link does not parse",
      ),
    );
  }
  if (storyUrl !== finalUrl && storyUrl !== canonical) {
    errors.push(
      issue(
        "URL_MISMATCH",
        `${path}.url`,
        `Story URL differs from the fetched page (${fetched.finalUrl})`,
      ),
    );
  }
  if (canonical && canonical !== finalUrl && !sameSite(canonical, finalUrl)) {
    warnings.push(
      issue(
        "CANONICAL_OFFSITE",
        `${path}.url`,
        `Canonical points to another site: ${article.canonicalUrl}`,
      ),
    );
  }

  const headline = bestHeadlineMatch(story.sourceHeadline, article);
  if (headline.score < headlineThreshold) {
    errors.push(
      issue(
        "HEADLINE_MISMATCH",
        `${path}.sourceHeadline`,
        `Best match ${headline.score.toFixed(2)} (${headline.field ?? "none"}: "${headline.value.slice(0, 80)}")`,
      ),
    );
  }

  const published = resolvePublishedDate(article);
  if (!published.date)
    errors.push(
      issue(
        "DATE_MISSING",
        `${path}.sourcePublishedOn`,
        published.urlOnly
          ? "Only a URL-path date was found; it is not accepted as sole evidence of publication"
          : "The article has no machine-readable or clearly labelled publication date",
      ),
    );
  else {
    // The story date must be the article's date in a time zone the source implies.
    if (!published.dates.includes(story.sourcePublishedOn))
      errors.push(
        issue(
          "DATE_MISMATCH",
          `${path}.sourcePublishedOn`,
          `Article says ${published.dates.join(" / ")} (${published.source})`,
        ),
      );
    if (published.conflicts.length)
      errors.push(
        issue(
          "DATE_CONFLICT",
          `${path}.sourcePublishedOn`,
          `Publication dates disagree beyond time-zone differences: ${published.source} vs ${published.conflicts.join(", ")}`,
        ),
      );
    if (published.ambiguous)
      warnings.push(
        issue(
          "DATE_AMBIGUOUS",
          `${path}.sourcePublishedOn`,
          `Date without time zone (${published.source})`,
        ),
      );
    if (published.weak)
      warnings.push(
        issue(
          "DATE_WEAK_SOURCE",
          `${path}.sourcePublishedOn`,
          `No date metadata; date taken from ${published.source}`,
        ),
      );
    if (published.urlMismatch.length)
      warnings.push(
        issue(
          "DATE_URL_MISMATCH",
          `${path}.sourcePublishedOn`,
          `URL path date differs: ${published.urlMismatch.join(", ")}`,
        ),
      );
  }

  if (article.sponsored)
    errors.push(
      issue(
        "SPONSORED",
        `${path}.url`,
        "The article is marked as sponsored or partner content",
      ),
    );
  if (fetched.evidence.hiddenInjectionSignals.length) {
    errors.push(
      issue(
        "HIDDEN_INSTRUCTIONS",
        `${path}.url`,
        `Hidden instruction-like text: ${fetched.evidence.hiddenInjectionSignals[0]}`,
      ),
    );
  }
  if (fetched.evidence.injectionSignals.length) {
    warnings.push(
      issue(
        "INSTRUCTION_TEXT_IN_SOURCE",
        `${path}.url`,
        `Visible instruction-like text (may be legitimate quoting): ${fetched.evidence.injectionSignals[0]}`,
      ),
    );
  }
  if (
    article.siteName &&
    story.publisher &&
    !normalizeForMatch(article.siteName).includes(
      normalizeForMatch(story.publisher),
    )
  ) {
    warnings.push(
      issue(
        "PUBLISHER_MISMATCH",
        `${path}.publisher`,
        `Page site name is "${article.siteName}"`,
      ),
    );
  }

  // Copyright: the English text against the source, and the French text when the source is French.
  const fields = [
    ["en", "summary"],
    ["en", "whyItMatters"],
  ];
  if (story.sourceHeadlineLang?.startsWith("fr"))
    fields.push(["fr", "summary"], ["fr", "whyItMatters"]);
  for (const [lang, field] of fields) {
    const result = checkCopyright(story[lang]?.[field] ?? "", article.text);
    if (!result.ok)
      errors.push(
        issue(
          "COPYRIGHT_OVERLAP",
          `${path}.${lang}.${field}`,
          `Shared with source: longest run ${result.longestCounted} words, ${result.segments} passage(s) of ${COPYRIGHT.minRun}+ words, coverage ${result.coverage}`,
        ),
      );
  }
  return { errors, warnings, headline, published };
}

// --- whole edition -------------------------------------------------------------------------

/**
 * Validates an edition. `articles` (optional) maps story id -> fetchArticle result.
 * Returns { ok, errors, warnings }.
 */
export function validateEdition(
  edition,
  { policy, now, history = [], articles, allowReview = false } = {},
) {
  const errors = checkSchema(edition);
  const warnings = [];
  if (errors.length) return { ok: false, errors, warnings };
  errors.push(...checkDates(edition, { now }));
  errors.push(...checkDuplicates(edition.stories, { history }));
  if (policy) {
    errors.push(...checkSourcePolicy(edition.stories, policy, { allowReview }));
    // Publishing automation must refuse to run while this warning is present.
    if (policy.status !== "approved")
      warnings.push(
        issue(
          "SOURCE_POLICY_PROVISIONAL",
          "policy",
          `Source policy status is "${policy.status ?? "unset"}", not "approved"`,
        ),
      );
  }
  edition.stories.forEach((story, i) => {
    const path = `stories[${i}]`;
    const bilingual = checkBilingual(story, path);
    errors.push(...bilingual.errors);
    warnings.push(...bilingual.warnings);
    errors.push(...checkEditorial(story, path));
    errors.push(...checkAttribution(story, path));
    if (articles) {
      const result = verifyAgainstArticle(story, articles[story.id], { path });
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }
  });
  return { ok: errors.length === 0, errors, warnings };
}

// CLI: node scripts/tech-brief/validate.mjs <edition.json> [--policy file] [--history dir] [--now ISO]
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const file = args.find(
    (a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"),
  );
  if (!file) {
    console.error(
      "Usage: node scripts/tech-brief/validate.mjs <edition.json> [--policy sources.json] [--history dir] [--now ISO]",
    );
    process.exit(2);
  }
  let edition;
  try {
    edition = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          errors: [issue("JSON", file, error.message)],
          warnings: [],
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  const policy = await loadSourcePolicy(
    option("--policy") ?? new URL("./sources.json", import.meta.url),
  );
  const history = option("--history")
    ? await loadHistory(option("--history"), {
        beforeEdition: edition?.edition,
      })
    : [];
  const now = option("--now") ? new Date(option("--now")) : new Date();
  const report = validateEdition(edition, { policy, history, now });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
