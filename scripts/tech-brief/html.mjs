// Extracts metadata and readable text from UNTRUSTED article HTML.
//
// Retrieved HTML is treated strictly as data: nothing is executed, no DOM or
// browser engine is used, scripts and styles are dropped, and JSON-LD is read
// with JSON.parse only. The tokenizer tolerates malformed markup (unclosed or
// mismatched tags) instead of failing.

import { cleanText, stripTitleSuffix } from "./text.mjs";

const VOID = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(
    " ",
  ),
);
const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "noscript",
  "template",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
]);
// Subtrees that never contribute article text.
const DROP = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "math",
  "iframe",
  "object",
  "embed",
  "canvas",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "select",
  "textarea",
  "dialog",
  "figure",
]);
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ul",
  "ol",
  "blockquote",
  "pre",
  "table",
  "tr",
  "td",
  "th",
  "dd",
  "dt",
  "dl",
  "br",
  "hr",
  "figcaption",
  "summary",
  "details",
]);
// Starting one of these implicitly closes an open <p> (simplified HTML rule).
const CLOSES_P = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "table",
  "blockquote",
  "pre",
  "hr",
]);

// Visible wording that marks a date as an update, not the publication date.
const UPDATE_TEXT =
  /(?:^|[^\p{L}])(?:updated|modified|revised|mise? à jour|modifié|actualisé)(?=$|[^\p{L}])/iu;

const MAX_HTML_CHARS = 2_500_000;
const MAX_JSONLD_CHARS = 200_000;
const MAX_JSONLD_BLOCKS = 10;

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  shy: "",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  sbquo: "‚",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  times: "×",
  divide: "÷",
  plusmn: "±",
  para: "¶",
  sect: "§",
  prime: "′",
  Prime: "″",
  eacute: "é",
  Eacute: "É",
  egrave: "è",
  Egrave: "È",
  ecirc: "ê",
  Ecirc: "Ê",
  euml: "ë",
  agrave: "à",
  Agrave: "À",
  acirc: "â",
  Acirc: "Â",
  auml: "ä",
  ccedil: "ç",
  Ccedil: "Ç",
  icirc: "î",
  Icirc: "Î",
  iuml: "ï",
  ocirc: "ô",
  Ocirc: "Ô",
  ouml: "ö",
  ucirc: "û",
  ugrave: "ù",
  uuml: "ü",
  oelig: "œ",
  OElig: "Œ",
  aelig: "æ",
  ntilde: "ñ",
  szlig: "ß",
  oslash: "ø",
  aring: "å",
  aacute: "á",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  yacute: "ý",
  yuml: "ÿ",
};

export function decodeEntities(value) {
  return value.replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});?/gi,
    (match, body) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        // Reject NUL, surrogates and out-of-range code points.
        if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
          return "�";
        return String.fromCodePoint(code);
      }
      return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
    },
  );
}

function parseAttributes(source) {
  const attrs = Object.create(null);
  const re =
    /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(source))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs))
      attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Tolerant tokenizer + tree builder. Returns a root node { tag, attrs, children }. */
export function parseHtml(html) {
  const input = String(html).slice(0, MAX_HTML_CHARS);
  const root = { tag: "#root", attrs: Object.create(null), children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const tagRe =
    /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>?|<\?[^>]*>?|<\/\s*([a-zA-Z][\w:-]*)[^>]*>?|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0;
  let m;

  const pushText = (text) => {
    if (text) top().children.push({ tag: "#text", text: decodeEntities(text) });
  };
  const closeTo = (tag) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tag === tag) {
        stack.length = i;
        return;
      }
    }
    // Unmatched end tag: ignored, as browsers do.
  };

  while ((m = tagRe.exec(input))) {
    pushText(input.slice(last, m.index));
    last = tagRe.lastIndex;
    if (m[1]) {
      closeTo(m[1].toLowerCase());
      continue;
    }
    if (!m[2]) continue; // comment, doctype, CDATA, processing instruction
    const tag = m[2].toLowerCase();
    const attrs = parseAttributes(m[3] ?? "");
    if (CLOSES_P.has(tag) && stack.some((n) => n.tag === "p")) closeTo("p");
    if (tag === "li" && top().tag === "li") stack.pop();
    const node = { tag, attrs, children: [] };
    top().children.push(node);
    if (RAW_TEXT.has(tag)) {
      // Raw text runs to the matching end tag; never parsed as markup.
      // As in browsers, "</tag" ends raw text when followed by whitespace, "/" or ">".
      const endRe = new RegExp(`</${tag}(?=[\\s/>])[^>]*>`, "ig");
      endRe.lastIndex = last;
      const end = endRe.exec(input);
      const raw = input.slice(last, end ? end.index : input.length);
      node.children.push({
        tag: "#text",
        text: tag === "title" || tag === "textarea" ? decodeEntities(raw) : raw,
        raw: true,
      });
      last = end ? endRe.lastIndex : input.length;
      tagRe.lastIndex = last;
      continue;
    }
    if (!VOID.has(tag) && !/\/\s*$/.test(m[3] ?? "")) stack.push(node);
  }
  pushText(input.slice(last));
  return root;
}

function* walk(node) {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

function isHidden(node) {
  const a = node.attrs;
  if (!a) return false;
  if ("hidden" in a || a["aria-hidden"] === "true") return true;
  const style = (a.style ?? "").toLowerCase().replace(/\s+/g, "");
  return /display:none|visibility:hidden|font-size:0(?:px)?(?:;|$)|opacity:0(?:;|$)/.test(
    style,
  );
}

/** Visible text of a subtree as paragraphs. Hidden and non-content elements are skipped. */
function collectParagraphs(node) {
  const paragraphs = [];
  let current = "";
  const flush = () => {
    const text = cleanText(current);
    if (text) paragraphs.push(text);
    current = "";
  };
  const visit = (n) => {
    if (n.tag === "#text") {
      if (!n.raw) current += n.text;
      return;
    }
    if (DROP.has(n.tag) || isHidden(n)) return;
    const block = BLOCK.has(n.tag);
    if (block) flush();
    for (const child of n.children) visit(child);
    if (block) flush();
  };
  visit(node);
  flush();
  return paragraphs;
}

function textOf(node) {
  return cleanText(
    [...walk(node)]
      .filter((n) => n.tag === "#text")
      .map((n) => n.text)
      .join(""),
  );
}

function findFirst(root, predicate) {
  for (const node of walk(root))
    if (node.tag !== "#text" && predicate(node)) return node;
  return null;
}

function readJsonLd(root) {
  const items = [];
  let blocks = 0;
  for (const node of walk(root)) {
    if (
      node.tag !== "script" ||
      (node.attrs.type ?? "").toLowerCase() !== "application/ld+json"
    )
      continue;
    if (++blocks > MAX_JSONLD_BLOCKS) break;
    const raw = node.children[0]?.text ?? "";
    if (raw.length > MAX_JSONLD_CHARS) continue;
    try {
      const data = JSON.parse(raw);
      const queue = Array.isArray(data) ? [...data] : [data];
      while (queue.length && items.length < 50) {
        const item = queue.shift();
        if (!item || typeof item !== "object") continue;
        if (Array.isArray(item["@graph"])) queue.push(...item["@graph"]);
        items.push(item);
      }
    } catch {
      // Malformed JSON-LD is ignored.
    }
  }
  return items;
}

const ARTICLE_TYPES =
  /^(?:NewsArticle|Article|BlogPosting|TechArticle|ReportageNews|AnalysisNewsArticle|Report|ScholarlyArticle|PressRelease|OpinionNewsArticle|SocialMediaPosting)$/;

function jsonLdString(value) {
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return jsonLdString(value[0]);
  if (value && typeof value === "object" && typeof value.name === "string")
    return cleanText(value.name);
  return "";
}

/**
 * Parses untrusted article HTML into metadata and paragraphs.
 * All returned strings are cleaned of control and bidi characters.
 */
export function extractArticle(html) {
  const root = parseHtml(html);
  const meta = Object.create(null);
  for (const node of walk(root)) {
    if (node.tag !== "meta") continue;
    const key = (
      node.attrs.property ??
      node.attrs.name ??
      node.attrs.itemprop ??
      ""
    ).toLowerCase();
    if (key && node.attrs.content !== undefined && !(key in meta))
      meta[key] = cleanText(node.attrs.content);
  }
  const htmlNode = findFirst(root, (n) => n.tag === "html");
  const titleNode = findFirst(root, (n) => n.tag === "title");
  const h1 = findFirst(root, (n) => n.tag === "h1" && !isHidden(n));
  const canonical = findFirst(
    root,
    (n) =>
      n.tag === "link" &&
      (n.attrs.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"),
  );

  const jsonLd = readJsonLd(root);
  const ldArticle = jsonLd.find((item) =>
    [item["@type"]]
      .flat()
      .some((t) => typeof t === "string" && ARTICLE_TYPES.test(t)),
  );
  const ldTypes = jsonLd
    .flatMap((item) => [item["@type"]].flat())
    .filter((t) => typeof t === "string");

  const timeNode =
    findFirst(
      root,
      (n) =>
        n.tag === "time" &&
        (n.attrs.itemprop === "datePublished" || "pubdate" in n.attrs) &&
        n.attrs.datetime,
    ) ??
    findFirst(
      findFirst(root, (n) => n.tag === "article") ?? { children: [] },
      (n) => n.tag === "time" && n.attrs.datetime,
    );

  const dateCandidates = [
    ["jsonld.datePublished", ldArticle?.datePublished],
    ["meta.article:published_time", meta["article:published_time"]],
    ["meta.og:published_time", meta["og:published_time"]],
    ["meta.datepublished", meta.datepublished],
    ["meta.date", meta.date],
    ["meta.pubdate", meta.pubdate],
    ["meta.publish-date", meta["publish-date"]],
    ["meta.dc.date.issued", meta["dc.date.issued"]],
    ["meta.parsely-pub-date", meta["parsely-pub-date"]],
    ["time.datetime", timeNode?.attrs.datetime],
  ]
    .filter(([, value]) => typeof value === "string" && value.trim())
    .map(([source, value]) => ({ source, value: cleanText(value) }));

  // Weaker fallbacks for pages without date metadata: a clearly identifiable
  // visible publication date, i.e. the text of a <time> element or a short
  // element labelled as a date or byline. Anything labelled as an update or
  // revision is skipped. Marked weak so validation prefers metadata.
  const labels = (n) =>
    `${n.attrs.class ?? ""} ${n.attrs.id ?? ""} ${n.attrs.itemprop ?? ""}`;
  const isUpdate = (n) =>
    /(?:^|[\s_-])(?:updated?|modified|revised|datemodified|last-?modified)(?:$|[\s_-])/i.test(
      labels(n),
    ) || UPDATE_TEXT.test(textOf(n));
  const timeText = findFirst(
    root,
    (n) => n.tag === "time" && !n.attrs.datetime && !isUpdate(n),
  );
  if (timeText)
    dateCandidates.push({
      source: "time.text",
      value: textOf(timeText).slice(0, 120),
      weak: true,
    });
  const dateLabel =
    /(?:^|[\s_-])(?:publish|published|pubdate|posted|post-date|date|dateline|byline)(?:$|[\s_-])/i;
  const byline = findFirst(
    root,
    (n) =>
      !DROP.has(n.tag) &&
      dateLabel.test(labels(n)) &&
      !isUpdate(n) &&
      textOf(n).length <= 160,
  );
  if (byline)
    dateCandidates.push({
      source: "byline.text",
      value: textOf(byline),
      weak: true,
    });

  // Main content: the <article> with the most visible text (pages often carry
  // several <article> teasers); if no article has substantial text, the
  // largest <main>; otherwise <body>.
  const largest = (tag) => {
    let best = { paragraphs: [], length: 0 };
    for (const node of walk(root)) {
      if (node.tag !== tag || isHidden(node)) continue;
      const candidate = collectParagraphs(node);
      const length = candidate.reduce((sum, p) => sum + p.length, 0);
      if (length > best.length) best = { paragraphs: candidate, length };
    }
    return best;
  };
  let content = largest("article");
  if (content.length < 500) {
    const main = largest("main");
    if (main.length > content.length) content = main;
  }
  const paragraphs =
    content.length > 0
      ? content.paragraphs
      : collectParagraphs(findFirst(root, (n) => n.tag === "body") ?? root);
  const fullText = paragraphs.join("\n");

  // Hidden text is not shown to readers but is a common carrier for injected
  // instructions, so it is reported separately and never used as evidence.
  const hiddenText = [];
  for (const node of walk(root))
    if (node.tag !== "#text" && isHidden(node) && !DROP.has(node.tag))
      hiddenText.push(textOf(node));

  return {
    lang: cleanText(htmlNode?.attrs.lang ?? meta["og:locale"] ?? "").slice(
      0,
      35,
    ),
    title: titleNode ? cleanText(titleNode.children[0]?.text ?? "") : "",
    titleWithoutSite: titleNode
      ? stripTitleSuffix(titleNode.children[0]?.text ?? "")
      : "",
    ogTitle: meta["og:title"] ?? "",
    twitterTitle: meta["twitter:title"] ?? "",
    h1: h1 ? textOf(h1) : "",
    jsonLdHeadline: jsonLdString(ldArticle?.headline),
    siteName: meta["og:site_name"] ?? jsonLdString(ldArticle?.publisher),
    author: jsonLdString(ldArticle?.author) || meta.author || "",
    canonicalUrl: canonical?.attrs.href ? cleanText(canonical.attrs.href) : "",
    ogUrl: meta["og:url"] ?? "",
    ogType: meta["og:type"] ?? "",
    jsonLdTypes: [...new Set(ldTypes)].slice(0, 20),
    dateCandidates,
    dateModified: cleanText(
      ldArticle?.dateModified ?? meta["article:modified_time"] ?? "",
    ),
    robots: (meta.robots ?? "").toLowerCase(),
    sponsored:
      /sponsored|advertorial|partner content|paid post|contenu sponsoris/i.test(
        [
          meta["article:section"],
          meta.keywords,
          meta["parsely-tags"],
          ldArticle?.articleSection,
        ]
          .flat()
          .filter(Boolean)
          .join(" "),
      ),
    paragraphs,
    text: fullText,
    hiddenText: hiddenText.filter(Boolean).slice(0, 20),
  };
}

// Instruction-like phrases that have no place in a news article. Matches are
// reported as signals; the content is never obeyed or executed.
const INJECTION_PATTERNS = [
  /\b(?:ignore|disregard|forget)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules)\b/i,
  /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
  /\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:ai|assistant|language model|chatgpt|claude|llm)\b/i,
  /\b(?:as an ai|assistant:|### ?instruction|<\|im_start\|>|\[\/?inst\])/i,
  /\b(?:ignore[zr]?|oublie[zr]?)\b[^.\n]{0,40}\binstructions?\b/i,
  /\b(?:respond|reply|answer)\s+only\s+with\b/i,
];

export function findInjectionSignals(text) {
  const signals = new Set();
  for (const re of INJECTION_PATTERNS) {
    for (const m of String(text).matchAll(new RegExp(re.source, "gi")))
      signals.add(m[0].slice(0, 120));
  }
  return [...signals].slice(0, 10);
}

/**
 * Builds a bounded evidence package for later (Phase 3) claim verification.
 * Paragraphs are numbered so claims can cite them; the package is explicitly
 * marked as untrusted data.
 */
export function buildEvidence(
  article,
  { maxChars = 20_000, minParagraphChars = 40 } = {},
) {
  const paragraphs = [];
  let used = 0;
  let truncated = false;
  for (const text of article.paragraphs) {
    if (text.length < minParagraphChars) continue;
    if (used + text.length > maxChars) {
      truncated = true;
      break;
    }
    paragraphs.push({ id: `p${paragraphs.length + 1}`, text });
    used += text.length;
  }
  const visible = paragraphs.map((p) => p.text).join("\n");
  return {
    trust: "untrusted-source-content",
    paragraphs,
    truncated,
    characters: used,
    injectionSignals: findInjectionSignals(visible),
    hiddenInjectionSignals: findInjectionSignals(article.hiddenText.join("\n")),
  };
}
