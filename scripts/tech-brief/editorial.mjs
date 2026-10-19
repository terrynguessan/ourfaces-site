// F5: editorial classification of an article as a whole (not of its claims).
//
// The extraction model reports separate facets (content type, sponsorship,
// technical substance, hype, vendor self-report). The decision to reject an
// article as promotional is made here, by fixed rules, so that it is
// deterministic, explained and recorded. A vendor reporting results about its
// own technology is never rejected for that alone: it must instead be
// attributed to the vendor in both languages. Classification never replaces
// quote matching, claim verification, provenance or distinct-evidence checks.

import { cleanText, normalizeForMatch } from "./text.mjs";

export const CONTENT_TYPES = [
  "independent-reporting",
  "original-research",
  "engineering-report",
  "product-announcement",
  "advertising",
  "marketing",
  "other",
];
export const TECHNICAL_SUBSTANCE = ["substantial", "limited", "none"];

// Source-policy kinds published by the organization whose work they describe.
const VENDOR_SOURCE_KINDS = new Set([
  "vendor",
  "vendor-engineering",
  "vendor-research",
]);

// Rules are applied in this order; the first match decides.
export const EDITORIAL_POLICY = Object.freeze({
  version: 1,
  accept: [
    "original technical research published by technology companies",
    "vendor engineering reports with concrete, verifiable technical findings",
    "product or technology announcements with significant, useful technical information",
    "research explaining actual capabilities, limitations, methods or measurable results",
  ],
  reject: [
    {
      code: "PROMOTIONAL_SPONSORED",
      rule: "sponsoredOrPaid",
      reason: "Paid, sponsored or partner content",
    },
    {
      code: "PROMOTIONAL_ADVERTISING",
      rule: "contentType = advertising",
      reason: "Advertisement rather than reporting or research",
    },
    {
      code: "PROMOTIONAL_MARKETING",
      rule: "contentType = marketing",
      reason: "Primarily promotional marketing material",
    },
    {
      code: "PROMOTIONAL_HYPE",
      rule: "unsupportedHype",
      reason:
        "Central claims are exaggerated or unsupported by the article itself",
    },
    {
      code: "PROMOTIONAL_LOW_SUBSTANCE",
      rule: "technicalSubstance = none, or limited for a vendor self-report or product announcement",
      reason: "Little meaningful technical information beyond promotion",
    },
  ],
  nonBlocking: [
    "vendorSelfReport: findings must be attributed to the reporting organization in the English and French summaries",
  ],
});

const RULES = Object.fromEntries(
  EDITORIAL_POLICY.reject.map((r) => [r.code, r]),
);

// Words separated by spaces, with apostrophes split so that French elisions
// ("d'Anthropic", "l'equipe") expose the following word.
const words = (value) =>
  normalizeForMatch(value)
    .replace(/'/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

function containsWords(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++)
    if (needle.every((w, j) => haystack[i + j] === w)) return true;
  return false;
}

/** True when `name` appears as whole words in `text` (case, accents and elisions ignored). */
export function mentions(text, name) {
  return containsWords(words(text), words(name));
}

// Words that do not identify an organization on their own.
const GENERIC_NAME_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "at",
  "for",
  "and",
  "le",
  "la",
  "les",
  "l",
  "de",
  "du",
  "des",
  "d",
  "et",
  "blog",
  "news",
  "newsroom",
  "engineering",
  "developer",
  "developers",
  "research",
  "team",
  "labs",
  "official",
]);

/**
 * The organization a self-report is attributed to. The default is the
 * publisher (page metadata, or the verified host when there is none). The
 * model's name is used only when it is part of the publisher's own name
 * ("GitHub" for "The GitHub Blog") or is the name of the verified source
 * domain ("Hugging Face" on huggingface.co). A company that is only mentioned
 * in the headline or the article, such as a competitor, is never used.
 */
function attribution(reportingOrganization, { publisher, sourceSite }) {
  const fallback = {
    name: cleanText(publisher ?? "").slice(0, 100) || null,
    basis: "publisher",
  };
  const name = cleanText(reportingOrganization ?? "").slice(0, 80);
  const nameWords = words(name);
  if (nameWords.every((w) => GENERIC_NAME_WORDS.has(w))) return fallback;
  if (containsWords(words(publisher ?? ""), nameWords))
    return { name, basis: "publisher-name" };
  const domainLabel = (sourceSite ?? "").toLowerCase().split(".")[0];
  if (domainLabel.length > 1 && nameWords.join("") === domainLabel)
    return { name, basis: "source-domain" };
  return fallback;
}

/**
 * Deterministic editorial decision from the model's facets and local facts.
 * `facets` is the extraction schema's `editorial` object (already validated).
 */
export function classifyEditorial(
  facets,
  { publisher = "", sourceSite = "", sourceKind = null } = {},
) {
  const f = facets ?? {};
  const contentType = CONTENT_TYPES.includes(f.contentType)
    ? f.contentType
    : "other";
  const technicalSubstance = TECHNICAL_SUBSTANCE.includes(f.technicalSubstance)
    ? f.technicalSubstance
    : "none";
  const signals = [
    f.vendorSelfReport === true && "model",
    VENDOR_SOURCE_KINDS.has(sourceKind) && "source-policy",
  ].filter(Boolean);
  const vendorSelfReport = signals.length > 0;
  const credit = vendorSelfReport
    ? attribution(f.reportingOrganization, { publisher, sourceSite })
    : null;

  let code = null;
  if (f.sponsoredOrPaid === true) code = "PROMOTIONAL_SPONSORED";
  else if (contentType === "advertising") code = "PROMOTIONAL_ADVERTISING";
  else if (contentType === "marketing") code = "PROMOTIONAL_MARKETING";
  else if (f.unsupportedHype === true) code = "PROMOTIONAL_HYPE";
  else if (
    technicalSubstance === "none" ||
    (technicalSubstance === "limited" &&
      (vendorSelfReport || contentType === "product-announcement"))
  )
    code = "PROMOTIONAL_LOW_SUBSTANCE";

  return {
    policyVersion: EDITORIAL_POLICY.version,
    contentType,
    technicalSubstance,
    sponsoredOrPaid: f.sponsoredOrPaid === true,
    unsupportedHype: f.unsupportedHype === true,
    vendorSelfReport,
    vendorSelfReportSignals: signals,
    attributedTo: credit?.name ?? null,
    attributionBasis: credit?.basis ?? null,
    promotional: code !== null,
    promotionalCode: code,
    promotionalReason: code ? RULES[code].reason : null,
    modelNote: code ? cleanText(f.promotionalEvidence ?? "").slice(0, 200) : "",
  };
}

// Reporting verbs and phrases that attribute a finding to its source. Words
// that are often nouns or adjectives (states, notes, précise) or that state a
// result as fact (found) are left out. Necessary, not sufficient: the
// faithfulness review judges the wording.
export const ATTRIBUTION_MARKERS = {
  en: [
    "according to",
    "report",
    "reports",
    "reported",
    "say",
    "says",
    "said",
    "stated",
    "announced",
    "announces",
    "describes",
    "described",
    "claims",
    "claimed",
    "writes",
    "wrote",
    "estimated",
  ],
  fr: [
    "selon",
    "d'après",
    "indique",
    "indiquent",
    "affirme",
    "affirment",
    "rapporte",
    "rapportent",
    "annonce",
    "annoncent",
    "déclare",
    "déclarent",
    "explique",
    "expliquent",
    "précisent",
    "décrit",
    "décrivent",
    "estime",
    "estiment",
    "constate",
    "constatent",
    "fait état",
    "signale",
    "signalent",
  ],
};

/**
 * A vendor self-report (story.evidence.editorial.vendorSelfReport) must name
 * the reporting organization with a reporting verb in both summaries, so that
 * company-reported findings are never presented as independently established.
 */
export function checkAttribution(story, path = "story") {
  const editorial = story?.evidence?.editorial;
  if (editorial?.vendorSelfReport !== true) return [];
  const name = editorial.attributedTo;
  if (typeof name !== "string" || !words(name).length)
    return [
      {
        code: "ATTRIBUTION_MISSING",
        path: `${path}.evidence.editorial.attributedTo`,
        message: "Vendor self-report without an organization to attribute",
      },
    ];
  const errors = [];
  for (const lang of ["en", "fr"]) {
    const summary = words(story[lang]?.summary ?? "");
    const named = containsWords(summary, words(name));
    const verb = ATTRIBUTION_MARKERS[lang].some((m) =>
      containsWords(summary, words(m)),
    );
    if (!named || !verb)
      errors.push({
        code: "ATTRIBUTION_MISSING",
        path: `${path}.${lang}.summary`,
        message: `Attribute the findings to ${name} (${[
          !named && "organization not named",
          !verb && "no reporting verb",
        ]
          .filter(Boolean)
          .join(", ")})`,
      });
  }
  return errors;
}
