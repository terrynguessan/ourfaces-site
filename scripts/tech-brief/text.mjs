// Pure text utilities shared by the Tech Brief validator and fetcher.
// No I/O and no dependencies, so every function is deterministic and testable.

// C0/C1 control characters plus bidirectional embedding, override and isolate
// marks. Matches the rule in src/lib/techBrief.ts.
export const UNSAFE_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_CHARS_GLOBAL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/g;

/** Removes control/bidi/zero-width characters and collapses whitespace. */
export function cleanText(value) {
  return String(value)
    .normalize("NFC")
    .replace(UNSAFE_CHARS_GLOBAL, "")
    .replace(/[\s\u00a0\u202f\u2007]+/g, " ")
    .trim();
}

/** Canonical form for comparisons: lowercase, no accents, unified quotes and dashes. */
export function normalizeForMatch(value) {
  return cleanText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...");
}

const WORD = /[\p{L}\p{N}]+(?:['.][\p{L}\p{N}]+)*/gu;

/** Word tokens for overlap and similarity checks (letters and digits only). */
export function tokenize(value) {
  return normalizeForMatch(value).match(WORD) ?? [];
}

/** Same tokens as tokenize(), but with the original letter case preserved. */
export function tokenizeKeepCase(value) {
  const folded = cleanText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[‘’‚‛′`´]/g, "'");
  return folded.match(WORD) ?? [];
}

const STOPWORDS = {
  en: new Set(
    "a an and are as at be been but by for from has have he her his in into is it its of on or our that the their them they this to was we were which will with you your not can may also more than about after over new now".split(
      " ",
    ),
  ),
  fr: new Set(
    "le la les un une des du de d l et ou est sont a ont au aux en dans par pour sur avec ce cet cette ces qui que qu il elle ils elles nous vous leur leurs son sa ses plus pas ne se sans entre comme mais donc aussi être peut peuvent selon".split(
      " ",
    ),
  ),
};

/** Fraction of tokens that are stop words of the given language (0..1). */
export function stopwordRatio(value, lang) {
  const tokens = tokenize(value).map((t) => t.replace(/^[dlcjmnst]'/, ""));
  if (tokens.length === 0) return 0;
  const set = STOPWORDS[lang];
  return tokens.filter((t) => set.has(t)).length / tokens.length;
}

/** Rough language guess for prose of at least a sentence. Returns "en", "fr" or null. */
export function guessLanguage(value) {
  const en = stopwordRatio(value, "en");
  const fr = stopwordRatio(value, "fr");
  if (Math.max(en, fr) < 0.12) return null;
  if (en > fr * 1.3) return "en";
  if (fr > en * 1.3) return "fr";
  return null;
}

const TITLE_SUFFIX = /\s+(?:[|·•»–—-]|::)\s+[^|·•»–—-]{2,60}$/;

/** Strips a trailing " | Site name" or " - Publisher" segment from a page title. */
export function stripTitleSuffix(title) {
  let result = cleanText(title);
  for (let i = 0; i < 2 && TITLE_SUFFIX.test(result); i++) {
    const stripped = result.replace(TITLE_SUFFIX, "");
    if (tokenize(stripped).length < 3) break;
    result = stripped;
  }
  return result;
}

function dice(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** Similarity of two headlines in 0..1, tolerant of site-name suffixes and punctuation. */
export function headlineSimilarity(expected, candidate) {
  const a = normalizeForMatch(stripTitleSuffix(expected));
  const b = normalizeForMatch(stripTitleSuffix(candidate));
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  const score = dice(ta, tb);
  // A page title that contains the full expected headline (or vice versa) is a match.
  const contained =
    (b.includes(a) && ta.size >= 4) || (a.includes(b) && tb.size >= 4);
  return contained ? Math.max(score, 0.95) : score;
}

/** Token-set similarity used for near-duplicate story detection. */
export function topicSimilarity(a, b) {
  const filter = (v) =>
    new Set(
      tokenize(v).filter((t) => !STOPWORDS.en.has(t) && !STOPWORDS.fr.has(t)),
    );
  return dice(filter(a), filter(b));
}

/**
 * Longest run of consecutive words shared by `text` and `source`, plus every
 * shared run of at least `minRun` words. Used for the copyright-overlap check.
 */
export function sharedRuns(text, source, minRun = 6) {
  const a = tokenize(text);
  const b = tokenize(source);
  if (a.length === 0 || b.length === 0)
    return { longest: 0, runs: [], coverage: 0 };

  // Index source positions of each token to keep this near-linear for prose.
  const positions = new Map();
  b.forEach((t, i) => {
    const list = positions.get(t);
    if (list) list.push(i);
    else positions.set(t, [i]);
  });

  let longest = 0;
  const covered = new Uint8Array(a.length);
  const runs = [];
  // runs: every maximal shared run of at least minRun words, with its position in `text`.
  for (let i = 0; i < a.length; i++) {
    for (const j of positions.get(a[i]) ?? []) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) continue; // not a run start
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      longest = Math.max(longest, k);
      if (k >= minRun) {
        runs.push({ start: i, length: k, words: a.slice(i, i + k).join(" ") });
        covered.fill(1, i, i + k);
      }
    }
  }
  const coverage = covered.reduce((sum, v) => sum + v, 0) / a.length;
  return { longest, runs, coverage, tokens: a.length };
}

/** Numbers, percentages, versions and amounts in a text, normalized across EN/FR formats. */
export function extractNumbers(value) {
  const text = cleanText(value).replace(
    /(\d)[\s\u00a0\u202f](?=\d{3}\b)/g,
    "$1",
  );
  const found = text.match(/\d+(?:[.,]\d+)*/g) ?? [];
  return found
    .map((n) => {
      // "1,200" (EN thousands) and "1 200" (FR thousands, joined above) -> "1200";
      // "1,5" (FR decimal) -> "1.5"; "5.0" stays a version/decimal.
      if (/^\d{1,3}(,\d{3})+$/.test(n)) return n.replace(/,/g, "");
      return n.replace(",", ".");
    })
    .sort();
}

/** Word count used for length caps. */
export function wordCount(value) {
  return tokenize(value).length;
}

/** Finds `quote` verbatim (after normalization) in `source`. */
export function containsQuote(source, quote) {
  const q = normalizeForMatch(quote).replace(/\s+/g, " ").trim();
  if (q.length < 12) return false;
  return normalizeForMatch(source).replace(/\s+/g, " ").includes(q);
}
