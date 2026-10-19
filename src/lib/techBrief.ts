import latestEdition from "@/content/tech-brief/latest.json";
import type { Locale } from "@/lib/i18n";

export const techBriefCategories = [
  "emerging-technology",
  "development-practices",
  "tools-techniques",
  "applied-ai",
] as const;

export type TechBriefCategory = (typeof techBriefCategories)[number];

/** Display text for one language. `headline` is the localized display headline. */
export type TechBriefStoryText = {
  headline: string;
  summary: string;
  whyItMatters: string;
};

/** Facts shared by both languages are stored once so EN and FR cannot diverge. */
export type TechBriefStory = {
  id: string;
  category: TechBriefCategory;
  url: string;
  publisher: string;
  sourcePublishedOn: string;
  sourceHeadline: string;
  sourceHeadlineLang: string;
  en: TechBriefStoryText;
  fr: TechBriefStoryText;
};

export type TechBriefEdition = {
  schemaVersion: 1;
  edition: string;
  publishedOn: string;
  stories: TechBriefStory[];
};

const MIN_STORIES = 3;
const MAX_STORIES = 5;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LANG_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const STORY_ID = /^[a-z0-9-]{1,40}$/;
// C0/C1 control characters plus bidirectional embedding, override and isolate marks.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !UNSAFE_CHARS.test(value)
  );
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function isSafeUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
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

function parseStoryText(raw: unknown): TechBriefStoryText | null {
  if (!isRecord(raw)) return null;
  const { headline, summary, whyItMatters } = raw;
  if (
    !isText(headline, 200) ||
    !isText(summary, 700) ||
    !isText(whyItMatters, 500)
  )
    return null;
  return { headline, summary, whyItMatters };
}

function parseStory(raw: unknown): TechBriefStory | null {
  if (!isRecord(raw)) return null;
  const {
    id,
    category,
    url,
    publisher,
    sourcePublishedOn,
    sourceHeadline,
    sourceHeadlineLang,
  } = raw;
  const en = parseStoryText(raw.en);
  const fr = parseStoryText(raw.fr);

  if (
    typeof id !== "string" ||
    !STORY_ID.test(id) ||
    !techBriefCategories.includes(category as TechBriefCategory) ||
    !isSafeUrl(url) ||
    !isText(publisher, 100) ||
    !isIsoDate(sourcePublishedOn) ||
    !isText(sourceHeadline, 200) ||
    typeof sourceHeadlineLang !== "string" ||
    !LANG_TAG.test(sourceHeadlineLang) ||
    !en ||
    !fr
  ) {
    return null;
  }

  return {
    id,
    category: category as TechBriefCategory,
    url,
    publisher,
    sourcePublishedOn,
    sourceHeadline,
    sourceHeadlineLang,
    en,
    fr,
  };
}

/** Validates an edition. Any problem rejects the whole edition (returns null), so
 *  the page falls back to its placeholder instead of showing partial content. */
export function parseEdition(raw: unknown): TechBriefEdition | null {
  if (!isRecord(raw) || raw.schemaVersion !== 1) return null;
  const { edition, publishedOn, stories } = raw;

  if (
    !isIsoDate(edition) ||
    !isIsoDate(publishedOn) ||
    !Array.isArray(stories) ||
    stories.length < MIN_STORIES ||
    stories.length > MAX_STORIES
  ) {
    return null;
  }

  const parsed: TechBriefStory[] = [];
  for (const story of stories) {
    const result = parseStory(story);
    if (!result || parsed.some((existing) => existing.id === result.id))
      return null;
    parsed.push(result);
  }

  return { schemaVersion: 1, edition, publishedOn, stories: parsed };
}

/** The current edition, or null when none is published or it fails validation. */
export function getLatestEdition() {
  return parseEdition(latestEdition as unknown);
}

/** Formats a YYYY-MM-DD date in the page language without time-zone day shifts. */
export function formatEditionDate(isoDate: string, locale: Locale) {
  return new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}
