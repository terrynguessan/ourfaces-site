// Phase 4 Sunday publication preparation: eligibility, verification
// evidence, full validation, the Sunday source recheck, public-content
// minimisation, atomic writes, recovery and website compatibility. Offline:
// articles are synthetic fixtures served by a fake fetcher, or by the real
// fetcher against a local HTTPS server; the approved and provisional source
// policies are test-only copies of the real lists with an explicit status.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFetcher } from "../fetch.mjs";
import { buildEvidence, extractArticle } from "../html.mjs";
import {
  EMPTY_EDITION,
  PublishError,
  contentDigest,
  preparePublication,
  publicEdition,
  publicEditionProblems,
  readPublishedState,
  serializeEdition,
} from "../publish.mjs";
import { loadConfig } from "../research.mjs";
import { loadSourcePolicy } from "../validate.mjs";
import {
  fixtureJson,
  loopbackResolver,
  makeCertificate,
  onlyLoopback,
  startServer,
} from "./helpers.mjs";

const config = await loadConfig();
const SOURCE_POLICY = await loadSourcePolicy(
  new URL("../sources.json", import.meta.url),
);
// TEST-ONLY copies with an explicit status, so these tests do not depend on
// the status of the real sources.json. The real policy file is not changed.
const APPROVED_POLICY = Object.freeze({ ...SOURCE_POLICY, status: "approved" });
const PROVISIONAL_POLICY = Object.freeze({
  ...SOURCE_POLICY,
  status: "provisional",
});
const NOW = new Date("2026-10-26T00:10:00.000Z"); // Sunday 25 Oct 20:10 EDT
const CLI = fileURLToPath(new URL("../publish.mjs", import.meta.url));

// --- Website parser (src/lib/techBrief.ts), loaded as in the research tests ---
const siteSource = readFileSync(
  fileURLToPath(new URL("../../../src/lib/techBrief.ts", import.meta.url)),
  "utf8",
)
  .replace(
    'import latestEdition from "@/content/tech-brief/latest.json";',
    "const latestEdition = null;",
  )
  .replace(
    'import type { Locale } from "@/lib/i18n";',
    'type Locale = "en" | "fr";',
  );
const siteDir = mkdtempSync(join(tmpdir(), "tech-brief-site-"));
writeFileSync(join(siteDir, "techBrief.ts"), siteSource);
const site = await import(pathToFileURL(join(siteDir, "techBrief.ts")).href);
rmSync(siteDir, { recursive: true, force: true });

// --- Synthetic articles and stories ------------------------------------------------------
const SAMPLE = Object.fromEntries(
  fixtureJson("valid-edition.json").stories.map((s) => [s.id, s]),
);
const SPECS = [
  {
    host: "blog.beta-ai.net",
    path: "/2026/10/structured-outputs-ga",
    site: "Beta AI Blog",
    published: "2026-10-21T12:00:00Z",
    date: "2026-10-21",
    lang: "en",
    category: "applied-ai",
    headline: SAMPLE.s1.sourceHeadline,
    text: SAMPLE.s1,
    paragraphs: [
      "Starting this week, every tier of the platform's API can return responses that are constrained by a developer-supplied JSON Schema.",
      "Before the change, only enterprise accounts could request schema-constrained output, and other customers had to validate and retry malformed replies themselves.",
      "The company said the decoder now refuses to emit tokens that would break the schema, so responses always parse.",
      "Existing integrations keep working without modification, and the feature is enabled per request through a new response format option.",
      "Pricing for constrained requests is unchanged from ordinary requests, according to the announcement.",
    ],
  },
  {
    host: "www.gamma-journal.org",
    path: "/articles/2026/10/test-flakiness-study",
    site: "Gamma Software Journal",
    published: "2026-10-20T08:00:00Z",
    date: "2026-10-20",
    lang: "en",
    category: "development-practices",
    headline: SAMPLE.s2.sourceHeadline,
    text: SAMPLE.s2,
    paragraphs: [
      "A team of researchers examined 1,200 open-source repositories to understand where intermittent test failures come from.",
      "They attributed 61% of the flaky failures they reproduced to fixtures that several tests shared and mutated in place.",
      "Projects that moved to per-test fixture copies saw the number of reruns in continuous integration fall noticeably over the following months.",
      "The authors caution that their sample favours larger projects with active maintenance.",
      "Their dataset and reproduction scripts have been published alongside the paper.",
    ],
  },
  {
    host: "news.alpha-devtools.com",
    path: "/releases/v5-0",
    site: "Alpha DevTools",
    published: "2026-10-22T09:30:00-04:00",
    date: "2026-10-22",
    lang: "en",
    category: "tools-techniques",
    headline: SAMPLE.s3.sourceHeadline,
    text: SAMPLE.s3,
    paragraphs: [
      "The 5.0 release of the command-line checker introduces an incremental mode that stores results from the previous run in a local cache.",
      "When incremental mode is on, the tool re-examines only files whose content changed and the modules that import them.",
      "On three large monorepos used for benchmarking, repeated checks after small edits completed up to four times faster.",
      "The cache lives in the project directory and can be cleared with a single flag when results look stale.",
      "No configuration changes are required to try the new mode.",
    ],
  },
  {
    host: "numerique.delta-actu.fr",
    path: "/actualites/2026/10/interoperabilite-identite-numerique",
    site: "Delta Actu Numérique",
    published: "2026-10-19T08:00:00+02:00",
    date: "2026-10-19",
    lang: "fr",
    category: "emerging-technology",
    headline: SAMPLE.s4.sourceHeadline,
    text: SAMPLE.s4,
    paragraphs: [
      "Un projet pilote transfrontalier va tester l’acceptation des portefeuilles d’identité numérique d’un État membre par les services d’un autre État.",
      "Les administrations et plusieurs entreprises privées participeront aux essais, qui s’appuieront sur une spécification technique partagée.",
      "Les résultats doivent orienter les règles d’interopérabilité que la Commission prévoit de publier l’an prochain.",
      "Les organisations participantes ont été sélectionnées à la suite d’un appel à candidatures lancé au printemps.",
      "Les citoyens volontaires pourront utiliser leur portefeuille pour ouvrir un compte bancaire ou s’inscrire à une université.",
    ],
  },
  {
    host: "www.epsilon-news.com",
    path: "/tech/container-image-signing",
    site: "Epsilon News",
    published: "2026-10-23T15:00:00Z",
    date: "2026-10-23",
    lang: "en",
    category: "tools-techniques",
    headline: "Registry to reject unsigned container images under new policy",
    text: {
      en: {
        headline: "Container registry adds mandatory image signature checks",
        summary:
          "The registry now rejects unsigned container images for organizations that enable the new policy. Administrators can require signatures per repository and review rejected pushes in an audit log.",
        whyItMatters:
          "Teams that ship containers can block untrusted images at the registry instead of relying on checks in each deployment pipeline.",
      },
      fr: {
        headline:
          "Le registre de conteneurs impose la vérification des signatures d’images",
        summary:
          "Le registre refuse désormais les images de conteneurs non signées pour les organisations qui activent la nouvelle politique. Les administrateurs peuvent exiger des signatures par dépôt et consulter les envois refusés dans un journal d’audit.",
        whyItMatters:
          "Les équipes qui livrent des conteneurs peuvent bloquer les images non fiables au niveau du registre plutôt que dans chaque pipeline de déploiement.",
      },
    },
    paragraphs: [
      "Organizations using the registry can now switch on a policy that refuses any container image pushed without a valid signature.",
      "The setting can be applied to individual repositories, so teams can roll it out gradually.",
      "Every refused push is recorded in the organization's audit log together with the identity that attempted it.",
      "Signatures created with the two most common open-source signing tools are accepted.",
      "The policy is off by default and does not affect images that were already stored.",
    ],
  },
];
const DOMAINS = [
  "beta-ai.net",
  "gamma-journal.org",
  "alpha-devtools.com",
  "delta-actu.fr",
  "epsilon-news.com",
];
const QUOTE_MARKER = "VERIFICATION-QUOTE"; // never present in public files
const defaultUrl = (spec) => `https://${spec.host}${spec.path}`;
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
// Closing paragraphs so each page has the article length the real fetcher requires.
const CLOSING = {
  en: [
    "Readers who want more detail can consult the full documentation linked from the original announcement.",
    "The publication will follow up as further information becomes available from the people involved.",
    "This article was reviewed by the editorial team before publication and corrected for clarity.",
    "Comments and corrections can be sent to the newsroom through the usual contact form.",
  ],
  fr: [
    "Les lecteurs qui souhaitent davantage de détails peuvent consulter la documentation complète liée à l’annonce d’origine.",
    "La rédaction publiera un suivi lorsque de nouvelles informations seront disponibles auprès des personnes concernées.",
    "Cet article a été relu par l’équipe éditoriale avant sa publication et corrigé pour plus de clarté.",
    "Les remarques et corrections peuvent être adressées à la rédaction par le formulaire de contact habituel.",
  ],
};
function page(
  spec,
  url,
  {
    headline = spec.headline,
    published = spec.published,
    paragraphs = spec.paragraphs,
    meta = "",
  } = {},
) {
  return `<!doctype html><html lang="${spec.lang}"><head><meta charset="utf-8">${meta}<title>${esc(headline)} | ${esc(spec.site)}</title>
<meta property="og:title" content="${esc(headline)}"><meta property="og:site_name" content="${esc(spec.site)}">
<meta property="article:published_time" content="${published}"><link rel="canonical" href="${url}"></head>
<body><main><article><h1>${esc(headline)}</h1>${[...paragraphs, ...CLOSING[spec.lang]].map((p) => `<p>${esc(p)}</p>`).join("")}</article></main></body></html>`;
}

/**
 * A synthetic authenticated research result: report + draft for the chosen
 * specs (ids renumbered s1..sN as research.mjs does), plus the article pages.
 */
function buildResult({
  picks = [0, 1, 2, 3, 4],
  edition = "2026-10-24",
  urlOf = defaultUrl,
  mode = "production",
  runId = "run-1a2b3c4d",
} = {}) {
  const pages = new Map();
  const stories = [];
  const candidates = [];
  picks.forEach((index, i) => {
    const spec = SPECS[index];
    const url = urlOf(spec);
    pages.set(url, { spec, html: page(spec, url) });
    const claims = [
      {
        id: "c1",
        text: `${QUOTE_MARKER} main claim ${i}`,
        quote: spec.paragraphs[0],
        paragraphId: "p1",
        quoteFound: true,
        verdict: "entailed",
      },
      {
        id: "c2",
        text: `${QUOTE_MARKER} second claim ${i}`,
        quote: spec.paragraphs[2],
        paragraphId: "p3",
        quoteFound: true,
        verdict: "entailed",
      },
    ];
    stories.push({
      id: `s${i + 1}`,
      category: spec.category,
      url,
      publisher: spec.site,
      sourcePublishedOn: spec.date,
      sourceHeadline: spec.headline,
      sourceHeadlineLang: spec.lang,
      en: structuredClone(spec.text.en),
      fr: structuredClone(spec.text.fr),
      evidence: {
        verification: claims.map((c) => ({
          claimId: c.id,
          claim: c.text,
          quote: c.quote,
          paragraphId: c.paragraphId,
          usedInSummary: true,
        })),
        corroboratedBy: [],
        editorial: {
          contentType: "independent-reporting",
          technicalSubstance: "substantial",
          vendorSelfReport: false,
          attributedTo: null,
        },
      },
    });
    candidates.push({
      key: `k${i + 1}`,
      url,
      status: "selected",
      storyId: `s${i + 1}`,
      verification: { status: "verified", distinctSupported: 2, claims },
    });
  });
  const publishedOn = new Date(Date.parse(`${edition}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  const draft = {
    schemaVersion: 1,
    edition,
    publishedOn,
    stories,
    generation: {
      runId,
      mode,
      policyStatus: "approved",
      provisionalPolicyOverride: false,
      models: { writing: "model-x" },
      estimatedCostUsd: 0.191048,
    },
  };
  const report = {
    schema: "ourfaces-tech-brief-research-report/1",
    runId,
    mode,
    edition,
    status: "edition",
    candidates,
    selected: candidates.map((c) => c.key),
    validation: { ok: true, errors: [], warnings: [] },
    budget: { runTotalCountedUsd: 0.191048 },
  };
  return { report, draft, pages };
}

/** Serves the pages; `changes` maps a story index to a change of its live article. */
function fakeFetcher(pages, changes = {}) {
  const calls = [];
  return {
    calls,
    fetchArticle: async (url) => {
      calls.push(url);
      const entry = pages.get(url);
      const change = entry ? changes[SPECS.indexOf(entry.spec)] : undefined;
      if (typeof change === "function") return change(url, entry);
      if (!entry || change === "missing")
        return {
          ok: false,
          code: "HTTP_STATUS",
          message: "HTTP 404",
          fetchedAt: NOW.toISOString(),
        };
      const html = change ? page(entry.spec, url, change) : entry.html;
      const article = extractArticle(html);
      return {
        ok: true,
        requestedUrl: url,
        finalUrl: url,
        article,
        evidence: buildEvidence(article),
      };
    },
  };
}

/** A content folder like src/content/tech-brief, in a temporary directory. */
function contentDir({ latest = EMPTY_EDITION, archive = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tb-publish-"));
  writeFileSync(join(dir, "latest.json"), serializeEdition(latest));
  if (archive.length) {
    mkdirSync(join(dir, "editions"));
    for (const e of archive)
      writeFileSync(
        join(dir, "editions", `${e.edition}.json`),
        serializeEdition(e),
      );
  }
  return dir;
}
const snapshot = (dir) => {
  const files = {
    "latest.json": readFileSync(join(dir, "latest.json"), "utf8"),
  };
  if (existsSync(join(dir, "editions")))
    for (const entry of readdirSync(join(dir, "editions"), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name)))
      files[`editions/${entry.name}`] = entry.isFile()
        ? readFileSync(join(dir, "editions", entry.name), "utf8")
        : "<folder>";
  return files;
};
/** A previously published public edition (three short synthetic stories). */
function previousEdition(
  edition = "2026-10-17",
  firstUrl = "https://www.zeta-weekly.com/a/one",
) {
  const story = (n, category, url) => ({
    id: `s${n}`,
    category,
    url,
    publisher: "Zeta Weekly",
    sourcePublishedOn: "2026-10-14",
    sourceHeadline: `Archived headline number ${n} about database replication`,
    sourceHeadlineLang: "en",
    en: {
      headline: `Archived story ${n}`,
      summary: `Archived summary ${n}.`,
      whyItMatters: `Archived relevance ${n}.`,
    },
    fr: {
      headline: `Article archivé ${n}`,
      summary: `Résumé archivé ${n}.`,
      whyItMatters: `Intérêt archivé ${n}.`,
    },
  });
  return {
    schemaVersion: 1,
    edition,
    publishedOn: new Date(Date.parse(`${edition}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10),
    stories: [
      story(1, "applied-ai", firstUrl),
      story(2, "tools-techniques", "https://www.zeta-weekly.com/a/two"),
      story(3, "development-practices", "https://www.zeta-weekly.com/a/three"),
    ],
  };
}
const prepare = (result, dir, { changes, ...args } = {}) =>
  preparePublication({
    report: result.report,
    draft: result.draft,
    policy: APPROVED_POLICY,
    config,
    fetcher: fakeFetcher(result.pages, changes),
    contentDir: dir,
    now: NOW,
    ...args,
  });
async function codeOf(promise) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PublishError) return error.code;
    throw error;
  }
  return "NO_ERROR";
}
async function errorOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

test("a valid five-story edition becomes two identical public files with only the public fields", async () => {
  const result = buildResult();
  const dir = contentDir();
  const outcome = await prepare(result, dir);
  assert.deepEqual(
    (({ status, edition, files, archiveCreated, dropped }) => ({
      status,
      edition,
      files,
      archiveCreated,
      dropped,
    }))(outcome),
    {
      status: "prepared",
      edition: "2026-10-24",
      files: ["latest.json", "editions/2026-10-24.json"],
      archiveCreated: true,
      dropped: [],
    },
  );
  const latest = readFileSync(join(dir, "latest.json"), "utf8");
  assert.equal(
    readFileSync(join(dir, "editions", "2026-10-24.json"), "utf8"),
    latest,
  );
  const published = JSON.parse(latest);
  assert.deepEqual(publicEditionProblems(published), []);
  assert.deepEqual(Object.keys(published), [
    "schemaVersion",
    "edition",
    "publishedOn",
    "stories",
  ]);
  for (const s of published.stories) {
    assert.deepEqual(Object.keys(s), [
      "id",
      "category",
      "url",
      "publisher",
      "sourcePublishedOn",
      "sourceHeadline",
      "sourceHeadlineLang",
      "en",
      "fr",
    ]);
    assert.deepEqual(Object.keys(s.en), [
      "headline",
      "summary",
      "whyItMatters",
    ]);
    assert.deepEqual(Object.keys(s.fr), [
      "headline",
      "summary",
      "whyItMatters",
    ]);
  }
  assert.deepEqual(published, publicEdition(result.draft));
  // Nothing private reaches the public file.
  for (const leak of [
    QUOTE_MARKER,
    ...SPECS.map((s) => s.paragraphs[0]),
    "evidence",
    "verification",
    "generation",
    "run-1a2b3c4d",
    "estimatedCostUsd",
    "editorial",
    "corroboratedBy",
    "model-x",
    "workflow",
    "OFTBUNDL",
  ])
    assert.ok(!latest.includes(leak), leak);
  assert.deepEqual(readPublishedState(dir).latestEdition, "2026-10-24");
  assert.deepEqual(
    outcome.warnings.filter((w) => w === "SOURCE_POLICY_PROVISIONAL"),
    [],
  );
});

test("the website parser accepts the public edition and renders both languages", async () => {
  const result = buildResult();
  const dir = contentDir();
  await prepare(result, dir);
  const published = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  const parsed = site.parseEdition(published);
  assert.ok(parsed, "parseEdition accepts the file");
  assert.equal(parsed.stories.length, 5);
  for (const [i, story] of parsed.stories.entries()) {
    assert.deepEqual(story.en, result.draft.stories[i].en);
    assert.deepEqual(story.fr, result.draft.stories[i].fr);
  }
  assert.equal(
    site.formatEditionDate(parsed.publishedOn, "en"),
    "October 25, 2026",
  );
  assert.equal(
    site.formatEditionDate(parsed.publishedOn, "fr"),
    "25 octobre 2026",
  );
});

test("three stories is the minimum: a four-story edition may lose one story on Sunday, but not two", async () => {
  const three = buildResult({ picks: [0, 1, 2] });
  assert.equal((await prepare(three, contentDir())).status, "prepared");

  const four = buildResult({ picks: [0, 1, 2, 3] });
  const dir = contentDir();
  const outcome = await prepare(four, dir, { changes: { 1: "missing" } });
  assert.deepEqual(outcome.dropped, [
    { id: "s2", reasons: ["SOURCE_UNAVAILABLE:HTTP_STATUS"] },
  ]);
  const published = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  assert.deepEqual(
    published.stories.map((s) => s.id),
    ["s1", "s3", "s4"],
  );
  assert.ok(
    !readFileSync(join(dir, "latest.json"), "utf8").includes(SPECS[1].headline),
  );

  const failing = contentDir();
  const before = snapshot(failing);
  const error = await errorOf(
    prepare(four, failing, { changes: { 1: "missing", 2: "missing" } }),
  );
  assert.equal(error.code, "INSUFFICIENT_STORIES");
  assert.equal(error.details.dropped.length, 2);
  assert.deepEqual(snapshot(failing), before);
});

test("editorial approval: only the exact previewed content is published; any difference needs a new review", async () => {
  const four = buildResult({ picks: [0, 1, 2, 3] });
  // The preview: every check, nothing written, the digest of the exact file text.
  const previewDir = contentDir();
  const untouched = snapshot(previewDir);
  const preview = await prepare(four, previewDir, { write: false });
  assert.equal(preview.status, "checked");
  assert.equal(preview.contentDigest, contentDigest(preview.text));
  assert.match(preview.contentDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(preview.droppedStories, []);
  assert.deepEqual(snapshot(previewDir), untouched);
  // The same research result always gives the same text and digest.
  const again = await prepare(four, contentDir(), { write: false });
  assert.equal(again.contentDigest, preview.contentDigest);

  // Supervised publication without an approval, or with a malformed one, is
  // refused before any source is fetched.
  const dir = contentDir();
  const before = snapshot(dir);
  let fetches = 0;
  const counting = {
    fetchArticle: async () => {
      fetches++;
      return { ok: false, code: "HTTP_STATUS" };
    },
  };
  assert.equal(
    await codeOf(
      prepare(four, dir, { requireApproval: true, fetcher: counting }),
    ),
    "APPROVAL_REQUIRED",
  );
  for (const bad of [
    "",
    "abc",
    "A".repeat(64),
    preview.contentDigest.toUpperCase(),
    ` ${preview.contentDigest}`,
    `${preview.contentDigest}0`,
  ])
    assert.equal(
      await codeOf(
        prepare(four, dir, {
          approvedDigest: bad,
          requireApproval: true,
          fetcher: counting,
        }),
      ),
      "APPROVAL_INVALID",
      JSON.stringify(bad),
    );
  assert.equal(fetches, 0);
  // Another digest is refused after every check, with nothing written.
  assert.equal(
    await codeOf(
      prepare(four, dir, {
        approvedDigest: "0".repeat(64),
        requireApproval: true,
      }),
    ),
    "APPROVAL_MISMATCH",
  );
  // A substituted edition (another set of stories) is refused too.
  assert.equal(
    await codeOf(
      prepare(buildResult({ picks: [0, 1, 2] }), dir, {
        approvedDigest: preview.contentDigest,
        requireApproval: true,
      }),
    ),
    "APPROVAL_MISMATCH",
  );
  assert.deepEqual(snapshot(dir), before);

  // The approved digest publishes exactly the previewed text, in both files.
  const ok = await prepare(four, dir, {
    approvedDigest: preview.contentDigest,
    requireApproval: true,
  });
  assert.equal(ok.status, "prepared");
  assert.equal(ok.contentDigest, preview.contentDigest);
  assert.equal(readFileSync(join(dir, "latest.json"), "utf8"), preview.text);
  assert.equal(
    readFileSync(join(dir, "editions", "2026-10-24.json"), "utf8"),
    preview.text,
  );

  // A story the Sunday recheck would drop after approval: the whole
  // publication is refused, the story is not silently removed.
  const later = contentDir();
  const laterBefore = snapshot(later);
  const error = await errorOf(
    prepare(four, later, {
      changes: { 1: "missing" },
      approvedDigest: preview.contentDigest,
      requireApproval: true,
    }),
  );
  assert.equal(error.code, "APPROVAL_MISMATCH");
  assert.deepEqual(error.details.dropped, [
    { id: "s2", reasons: ["SOURCE_UNAVAILABLE:HTTP_STATUS"] },
  ]);
  assert.deepEqual(snapshot(later), laterBefore);
  // A new preview shows the drop, with the dropped story's public fields only.
  const reduced = await prepare(four, contentDir(), {
    changes: { 1: "missing" },
    write: false,
  });
  assert.deepEqual(
    reduced.dropped.map((d) => d.id),
    ["s2"],
  );
  assert.deepEqual(
    reduced.droppedStories.map((s) => s.id),
    ["s2"],
  );
  assert.deepEqual(
    Object.keys(reduced.droppedStories[0]),
    Object.keys(JSON.parse(preview.text).stories[1]),
  );
  assert.ok(!JSON.stringify(reduced.droppedStories).includes(QUOTE_MARKER));
  assert.notEqual(reduced.contentDigest, preview.contentDigest);

  // Automated mode (no approval required) still publishes the reduced edition.
  const automated = contentDir();
  const auto = await prepare(four, automated, { changes: { 1: "missing" } });
  assert.equal(auto.status, "prepared");
  assert.equal(auto.contentDigest, reduced.contentDigest);
});

test("Sunday source recheck: missing, changed, moved, sponsored or redated articles are dropped", async () => {
  const cases = [
    ["missing", "missing", "SOURCE_UNAVAILABLE:HTTP_STATUS"],
    [
      "headline changed",
      { headline: "An entirely different story about gardening tools" },
      "HEADLINE_MISMATCH",
    ],
    [
      "verified quote removed",
      { paragraphs: SPECS[0].paragraphs.slice(1) },
      "QUOTE_NOT_FOUND:c1",
    ],
    [
      "sponsored",
      { meta: '<meta property="article:section" content="Sponsored">' },
      "SPONSORED",
    ],
    ["redated", { published: "2026-10-23T12:00:00Z" }, "DATE_MISMATCH"],
    [
      "redirected elsewhere",
      (url, entry) => {
        const article = extractArticle(
          page(entry.spec, "https://elsewhere.beta-ai.net/x"),
        );
        return {
          ok: true,
          requestedUrl: url,
          finalUrl: "https://elsewhere.beta-ai.net/x",
          article,
          evidence: buildEvidence(article),
        };
      },
      "URL_MISMATCH",
    ],
  ];
  for (const [name, change, reason] of cases) {
    const dir = contentDir();
    const outcome = await prepare(buildResult(), dir, {
      changes: { 0: change },
    });
    assert.equal(outcome.status, "prepared", name);
    assert.equal(outcome.dropped.length, 1, name);
    assert.ok(
      outcome.dropped[0].reasons.includes(reason),
      `${name}: ${outcome.dropped[0].reasons}`,
    );
    const published = JSON.parse(
      readFileSync(join(dir, "latest.json"), "utf8"),
    );
    assert.equal(published.stories.length, 4, name);
    assert.ok(
      !published.stories.some((s) => s.url === defaultUrl(SPECS[0])),
      name,
    );
  }
});

test("failed or inconsistent verification evidence rejects the whole edition", async () => {
  const cases = {
    "candidate not verified": (r) =>
      (r.report.candidates[1].verification.status = "failed"),
    "quote differs from the report": (r) =>
      (r.draft.stories[2].evidence.verification[1].quote =
        SPECS[2].paragraphs[3]),
    "only one claim": (r) => r.draft.stories[0].evidence.verification.pop(),
    // Two valid entailed report claims (c2, c3), but not the main claim c1.
    "main claim missing": (r) => {
      const claim = {
        id: "c3",
        text: "third claim",
        quote: SPECS[3].paragraphs[3],
        paragraphId: "p4",
        quoteFound: true,
        verdict: "entailed",
      };
      r.report.candidates[3].verification.claims.push(claim);
      r.draft.stories[3].evidence.verification[0] = {
        claimId: "c3",
        claim: claim.text,
        quote: claim.quote,
        paragraphId: "p4",
        usedInSummary: true,
      };
    },
    "claim only partially supported": (r) =>
      (r.report.candidates[4].verification.claims[1].verdict = "partial"),
    "too few distinct claims": (r) =>
      (r.report.candidates[0].verification.distinctSupported = 1),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const result = buildResult();
    mutate(result);
    const dir = contentDir();
    const before = snapshot(dir);
    assert.equal(
      await codeOf(prepare(result, dir)),
      "VERIFICATION_FAILED",
      name,
    );
    assert.deepEqual(snapshot(dir), before, name);
  }
});

test("publication timing: not early, not after the scheduled window, manual recovery until the next cutoff", async () => {
  const at = (iso, trigger) =>
    prepare(buildResult(), contentDir(), { now: new Date(iso), trigger });
  const early = await errorOf(at("2026-10-25T23:59:59.000Z")); // Sunday 19:59:59 EDT
  assert.deepEqual([early.code, early.details.decision], ["NOT_DUE", "EARLY"]);
  const missed = await errorOf(at("2026-10-26T16:00:00.000Z")); // Monday 12:00 EDT
  assert.deepEqual(
    [missed.code, missed.details.decision],
    ["NOT_DUE", "MISSED"],
  );
  assert.equal(
    (await at("2026-10-26T17:00:00.000Z", "manual")).status,
    "prepared",
  );
  const stale = await errorOf(at("2026-11-01T00:00:00.000Z", "manual")); // next Saturday 20:00 EDT
  assert.deepEqual([stale.code, stale.details.decision], ["NOT_DUE", "STALE"]);
  // A result for another edition than the one due.
  const other = buildResult({ edition: "2026-10-17" });
  assert.equal(await codeOf(prepare(other, contentDir())), "EDITION_MISMATCH");
});

test("duplicates: a published edition is not prepared again, older editions are refused, archived stories are not repeated", async () => {
  const dir = contentDir();
  await prepare(buildResult(), dir);
  const after = snapshot(dir);
  const fetcher = fakeFetcher(buildResult().pages);
  const again = await preparePublication({
    ...buildResult(),
    policy: APPROVED_POLICY,
    config,
    fetcher,
    contentDir: dir,
    now: NOW,
  });
  assert.deepEqual(
    [again.status, again.files, fetcher.calls.length],
    ["already-published", [], 0],
  );
  assert.deepEqual(snapshot(dir), after);

  const newer = previousEdition("2026-10-31");
  const superseded = contentDir({ latest: newer, archive: [newer] });
  assert.equal(
    await codeOf(prepare(buildResult(), superseded, { trigger: "manual" })),
    "SUPERSEDED",
  );

  const previous = previousEdition("2026-10-17", defaultUrl(SPECS[0]));
  const repeated = contentDir({ latest: previous, archive: [previous] });
  const before = snapshot(repeated);
  const error = await errorOf(prepare(buildResult(), repeated));
  assert.equal(error.code, "VALIDATION_FAILED");
  assert.ok(
    error.details.codes.includes("REPEAT_URL"),
    String(error.details.codes),
  );
  assert.deepEqual(snapshot(repeated), before);
});

test("an invalid research edition is rejected outright, even if the invalid story is also gone on Sunday", async () => {
  const result = buildResult();
  result.draft.stories[0].fr = structuredClone(result.draft.stories[0].en);
  const dir = contentDir();
  const before = snapshot(dir);
  const error = await errorOf(
    prepare(result, dir, { changes: { 0: "missing" } }),
  );
  assert.equal(error.code, "VALIDATION_FAILED");
  assert.ok(error.details.codes.includes("FR_UNTRANSLATED"));
  assert.deepEqual(snapshot(dir), before);
});

test("incomplete or untranslated French is refused", async () => {
  const untranslated = buildResult();
  untranslated.draft.stories[1].fr = structuredClone(
    untranslated.draft.stories[1].en,
  );
  assert.equal(
    await codeOf(prepare(untranslated, contentDir())),
    "VALIDATION_FAILED",
  );
  const missing = buildResult();
  delete missing.draft.stories[2].fr.whyItMatters;
  assert.equal(
    await codeOf(prepare(missing, contentDir())),
    "INCONSISTENT_RESULT",
  );
  const empty = buildResult();
  empty.draft.stories[0].fr.summary = "";
  assert.equal(
    await codeOf(prepare(empty, contentDir())),
    "INCONSISTENT_RESULT",
  );
});

test("category diversity: the stories, including after Sunday's drops, must cover at least two categories", async () => {
  assert.equal(
    await codeOf(prepare(buildResult({ picks: [2, 4] }), contentDir())),
    "INCONSISTENT_RESULT",
    "two stories never pass the schema",
  );
  const twoCategories = buildResult({ picks: [0, 2, 4] }); // applied-ai + tools x2
  const dir = contentDir();
  const before = snapshot(dir);
  const error = await errorOf(
    prepare(twoCategories, dir, { changes: { 0: "missing" } }),
  );
  // Losing the only applied-ai story leaves two tools stories: too few stories and one category.
  assert.ok(
    ["INSUFFICIENT_STORIES", "INSUFFICIENT_CATEGORIES"].includes(error.code),
  );
  assert.deepEqual(snapshot(dir), before);
  const fourStories = buildResult({ picks: [0, 2, 4, 1] });
  fourStories.draft.stories[3].category = "tools-techniques";
  fourStories.report.candidates[3].category = "tools-techniques";
  const narrow = contentDir();
  assert.equal(
    await codeOf(prepare(fourStories, narrow, { changes: { 0: "missing" } })),
    "INSUFFICIENT_CATEGORIES",
  );
  assert.deepEqual(snapshot(narrow), snapshot(contentDir()));
});

test("source policy: provisional policy, provisional research and dry runs are refused, with no override", async () => {
  const dir = contentDir();
  const before = snapshot(dir);
  const run = (result, policy, extra = {}) =>
    codeOf(
      preparePublication({
        report: result.report,
        draft: result.draft,
        policy,
        config,
        fetcher: fakeFetcher(result.pages),
        contentDir: dir,
        now: NOW,
        ...extra,
      }),
    );
  assert.equal(
    await run(buildResult(), PROVISIONAL_POLICY),
    "POLICY_NOT_APPROVED",
  );
  assert.equal(
    await run(buildResult(), PROVISIONAL_POLICY, {
      allowProvisionalPolicy: true,
      mode: "dry-run",
    }),
    "POLICY_NOT_APPROVED",
  );
  assert.equal(await run(buildResult(), undefined), "POLICY_NOT_APPROVED");
  // Research made under a provisional policy, flagged either way.
  for (const generation of [
    { policyStatus: "provisional", provisionalPolicyOverride: true },
    { policyStatus: "provisional", provisionalPolicyOverride: false },
    { policyStatus: "approved", provisionalPolicyOverride: true },
  ]) {
    const provisionalResearch = buildResult();
    Object.assign(provisionalResearch.draft.generation, generation);
    assert.equal(
      await run(provisionalResearch, APPROVED_POLICY),
      "POLICY_NOT_APPROVED",
      JSON.stringify(generation),
    );
  }
  assert.equal(
    await run(buildResult({ mode: "dry-run" }), APPROVED_POLICY),
    "NOT_PRODUCTION",
  );
  assert.deepEqual(
    await loadSourcePolicy(new URL("../sources.json", import.meta.url)),
    SOURCE_POLICY,
    "the real policy file is unchanged",
  );
  assert.deepEqual(snapshot(dir), before);
});

test("interrupted and repeated preparation: an identical archive copy is completed, a different one is refused", async () => {
  const result = buildResult();
  const expected = (await prepare(result, contentDir(), { write: false })).text;
  // Crash after the archive rename, before latest.json: the next run completes it.
  const resumed = contentDir();
  mkdirSync(join(resumed, "editions"));
  writeFileSync(join(resumed, "editions", "2026-10-24.json"), expected);
  const outcome = await prepare(result, resumed);
  assert.deepEqual(
    [outcome.status, outcome.archiveCreated],
    ["prepared", false],
  );
  assert.equal(readFileSync(join(resumed, "latest.json"), "utf8"), expected);

  // A different archive copy for the edition is a conflict.
  const conflict = contentDir();
  mkdirSync(join(conflict, "editions"));
  const other = serializeEdition({
    ...JSON.parse(expected),
    stories: JSON.parse(expected).stories.slice(0, 3),
  });
  writeFileSync(join(conflict, "editions", "2026-10-24.json"), other);
  const before = snapshot(conflict);
  assert.equal(await codeOf(prepare(result, conflict)), "ARCHIVE_CONFLICT");
  assert.deepEqual(snapshot(conflict), before);

  // A check-only run writes nothing.
  const dry = contentDir();
  const drySnapshot = snapshot(dry);
  const checked = await prepare(result, dry, { write: false });
  assert.equal(checked.status, "checked");
  assert.deepEqual(snapshot(dry), drySnapshot);

  // A crashed write leaves a temporary file in editions/: refused until cleaned up.
  const leftover = contentDir();
  mkdirSync(join(leftover, "editions"));
  writeFileSync(
    join(leftover, "editions", "2026-10-24.json.tmp-1-deadbeef"),
    "partial",
  );
  assert.equal(await codeOf(prepare(result, leftover)), "STATE_INVALID");
  // No temporary files are left behind after a successful run.
  const clean = contentDir();
  await prepare(result, clean);
  assert.deepEqual(readdirSync(clean).sort(), ["editions", "latest.json"]);
  assert.deepEqual(readdirSync(join(clean, "editions")), ["2026-10-24.json"]);
});

test("files changed by someone else during preparation are never overwritten", async () => {
  const result = buildResult();
  const modifyLatest = contentDir();
  const fetcher = fakeFetcher(result.pages);
  const changingFetcher = {
    fetchArticle: async (url) => {
      writeFileSync(
        join(modifyLatest, "latest.json"),
        serializeEdition(EMPTY_EDITION).replace("\n}", ',\n  "x": 1\n}'),
      );
      return fetcher.fetchArticle(url);
    },
  };
  const changed = readFileSync(join(modifyLatest, "latest.json"), "utf8");
  assert.equal(
    await codeOf(
      preparePublication({
        ...result,
        policy: APPROVED_POLICY,
        config,
        fetcher: changingFetcher,
        contentDir: modifyLatest,
        now: NOW,
      }),
    ),
    "STATE_CHANGED",
  );
  assert.notEqual(
    readFileSync(join(modifyLatest, "latest.json"), "utf8"),
    changed,
  );
  assert.ok(!existsSync(join(modifyLatest, "editions", "2026-10-24.json")));

  const racingArchive = contentDir();
  const archiveFetcher = {
    fetchArticle: async (url) => {
      mkdirSync(join(racingArchive, "editions"), { recursive: true });
      writeFileSync(join(racingArchive, "editions", "2026-10-24.json"), "{}");
      return fetcher.fetchArticle(url);
    },
  };
  assert.equal(
    await codeOf(
      preparePublication({
        ...result,
        policy: APPROVED_POLICY,
        config,
        fetcher: archiveFetcher,
        contentDir: racingArchive,
        now: NOW,
      }),
    ),
    "ARCHIVE_CONFLICT",
  );
  assert.equal(
    readFileSync(join(racingArchive, "latest.json"), "utf8"),
    serializeEdition(EMPTY_EDITION),
  );
});

test("a failed final swap removes the archive copy this run created and leaves latest.json untouched", async () => {
  const result = buildResult();
  // Fault injection: replacing latest.json fails; every other rename is real.
  const renames = [];
  const failLatest = (from, to) => {
    renames.push(to);
    if (to.endsWith("latest.json"))
      throw Object.assign(new Error("simulated rename failure"), {
        code: "EPERM",
      });
    renameSync(from, to);
  };
  const tempFiles = (dir) =>
    [
      ...readdirSync(dir),
      ...(existsSync(join(dir, "editions"))
        ? readdirSync(join(dir, "editions"))
        : []),
    ].filter((n) => n.includes(".tmp-"));

  // A first run: the archive copy it wrote is removed again.
  const previous = previousEdition();
  const dir = contentDir({ latest: previous, archive: [previous] });
  const before = snapshot(dir);
  await assert.rejects(
    prepare(result, dir, { rename: failLatest }),
    /simulated rename failure/,
  );
  assert.ok(
    renames.some((to) => to.endsWith(join("editions", "2026-10-24.json"))),
    "the archive copy was renamed into place first",
  );
  assert.deepEqual(
    snapshot(dir),
    before,
    "previous edition and archive unchanged",
  );
  assert.deepEqual(tempFiles(dir), []);
  assert.equal(readPublishedState(dir).latestEdition, "2026-10-17");

  // A resumed run: an archive copy it did not create is kept.
  const expected = (await prepare(result, contentDir(), { write: false })).text;
  const resumed = contentDir();
  mkdirSync(join(resumed, "editions"));
  writeFileSync(join(resumed, "editions", "2026-10-24.json"), expected);
  await assert.rejects(
    prepare(result, resumed, { rename: failLatest }),
    /simulated rename failure/,
  );
  assert.equal(
    readFileSync(join(resumed, "editions", "2026-10-24.json"), "utf8"),
    expected,
  );
  assert.equal(
    readFileSync(join(resumed, "latest.json"), "utf8"),
    serializeEdition(EMPTY_EDITION),
  );
  assert.deepEqual(tempFiles(resumed), []);
  // The default (real) rename then completes it.
  assert.equal((await prepare(result, resumed)).status, "prepared");
});

test("unexpected repository state is refused before anything else", async () => {
  const previous = previousEdition();
  const cases = {
    "latest.json is not JSON": (dir) =>
      writeFileSync(join(dir, "latest.json"), "not json"),
    "latest.json differs from its archive": (dir) =>
      writeFileSync(
        join(dir, "latest.json"),
        serializeEdition({
          ...previous,
          stories: previous.stories.slice(0, 3).reverse(),
        }),
      ),
    "latest.json has private fields": (dir) =>
      writeFileSync(
        join(dir, "latest.json"),
        serializeEdition({
          ...previous,
          generation: { runId: "run-1a2b3c4d" },
        }),
      ),
    "unexpected file in editions": (dir) =>
      writeFileSync(join(dir, "editions", "notes.txt"), "x"),
    "archive copy with private fields": (dir) =>
      writeFileSync(
        join(dir, "editions", "2026-10-10.json"),
        serializeEdition({
          ...previousEdition("2026-10-10"),
          stories: previousEdition("2026-10-10").stories.map((s) => ({
            ...s,
            evidence: {},
          })),
        }),
      ),
    "archive file named for another edition": (dir) =>
      writeFileSync(
        join(dir, "editions", "2026-10-03.json"),
        serializeEdition(previousEdition("2026-10-10")),
      ),
    "a newer archive than latest that is not this edition": (dir) =>
      writeFileSync(
        join(dir, "editions", "2026-10-31.json"),
        serializeEdition(previousEdition("2026-10-31")),
      ),
    "a folder inside editions": (dir) =>
      mkdirSync(join(dir, "editions", "2026-10-10.json")),
  };
  for (const [name, corrupt] of Object.entries(cases)) {
    const dir = contentDir({ latest: previous, archive: [previous] });
    corrupt(dir);
    const before = snapshot(dir);
    assert.equal(
      await codeOf(prepare(buildResult(), dir)),
      "STATE_INVALID",
      name,
    );
    assert.deepEqual(snapshot(dir), before, name);
  }
  // A missing latest.json is refused too.
  const empty = mkdtempSync(join(tmpdir(), "tb-publish-"));
  assert.equal(await codeOf(prepare(buildResult(), empty)), "STATE_INVALID");
});

test("the previous edition is preserved byte for byte whenever preparation fails", async () => {
  const previous = previousEdition();
  const failures = {
    verification: (r) =>
      (r.report.candidates[0].verification.status = "failed"),
    "too many dropped stories": null,
    untranslated: (r) =>
      (r.draft.stories[0].fr = structuredClone(r.draft.stories[0].en)),
  };
  for (const [name, mutate] of Object.entries(failures)) {
    const dir = contentDir({ latest: previous, archive: [previous] });
    const before = snapshot(dir);
    const result = buildResult();
    if (mutate) mutate(result);
    const changes = mutate ? {} : { 0: "missing", 1: "missing", 2: "missing" };
    assert.notEqual(
      await codeOf(prepare(result, dir, { changes })),
      "NO_ERROR",
      name,
    );
    assert.deepEqual(snapshot(dir), before, name);
    assert.equal(readPublishedState(dir).latestEdition, "2026-10-17", name);
  }
  // And a successful run keeps the previous edition in the archive.
  const dir = contentDir({ latest: previous, archive: [previous] });
  await prepare(buildResult(), dir);
  assert.deepEqual(Object.keys(snapshot(dir)), [
    "latest.json",
    "editions/2026-10-17.json",
    "editions/2026-10-24.json",
  ]);
  assert.equal(
    snapshot(dir)["editions/2026-10-17.json"],
    serializeEdition(previous),
  );
});

test("public projection keeps only whitelisted fields and the public check rejects anything extra", () => {
  const result = buildResult();
  const noisy = structuredClone(result.draft);
  noisy.internalNote = "x";
  noisy.stories[0].reviewNote = "x";
  noisy.stories[0].en.claimIds = ["c1"];
  const pub = publicEdition(noisy);
  assert.deepEqual(publicEditionProblems(pub), []);
  assert.ok(!JSON.stringify(pub).includes("reviewNote"));
  assert.ok(!JSON.stringify(pub).includes("claimIds"));
  assert.ok(publicEditionProblems({ ...pub, generation: {} }).length > 0);
  assert.ok(
    publicEditionProblems({
      ...pub,
      stories: [{ ...pub.stories[0], evidence: {} }, ...pub.stories.slice(1)],
    }).length > 0,
  );
  assert.ok(
    publicEditionProblems({
      ...pub,
      stories: [
        { ...pub.stories[0], en: { ...pub.stories[0].en, claimIds: [] } },
        ...pub.stories.slice(1),
      ],
    }).length > 0,
  );
  assert.ok(
    publicEditionProblems({ ...pub, stories: pub.stories.slice(0, 2) }).length >
      0,
    "fewer than three stories",
  );
  assert.ok(
    publicEditionProblems({
      ...pub,
      stories: [...pub.stories, { ...pub.stories[0], id: "s6" }],
    }).length > 0,
    "more than five stories",
  );
});

test("CLI check reports the published state without changing it", () => {
  const run = (dir) => {
    try {
      return {
        status: 0,
        json: JSON.parse(
          execFileSync(process.execPath, [CLI, "check", "--content-dir", dir], {
            encoding: "utf8",
          }),
        ),
      };
    } catch (error) {
      return { status: error.status, json: JSON.parse(error.stdout) };
    }
  };
  const previous = previousEdition();
  const good = run(contentDir({ latest: previous, archive: [previous] }));
  assert.deepEqual(
    [good.status, good.json.latestEdition, good.json.archived],
    [0, "2026-10-17", ["2026-10-17"]],
  );
  const bad = contentDir({ latest: previous, archive: [previous] });
  writeFileSync(join(bad, "editions", "notes.txt"), "x");
  assert.deepEqual([run(bad).status, run(bad).json.code], [4, "STATE_INVALID"]);
  const placeholder = run(contentDir());
  assert.deepEqual(
    [placeholder.status, placeholder.json.latestEdition],
    [0, null],
  );
});

// --- The real fetcher, against a local HTTPS server -----------------------------------------
const tls = makeCertificate(DOMAINS);
describe(
  "Sunday recheck through fetch.mjs",
  { skip: tls ? false : "OpenSSL not available" },
  () => {
    test("articles are re-fetched with the production fetcher and its safeguards", async () => {
      // The server reads `routes` per request, so they can be filled once the port is known.
      const routes = {};
      const server = await startServer(tls, routes);
      try {
        const urlOf = (spec) =>
          `https://${spec.host}:${server.port}${spec.path}`;
        const result = buildResult({ urlOf });
        for (const [url, entry] of result.pages) {
          const u = new URL(url);
          routes[`${u.hostname} ${u.pathname}`] = (req, res) => {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(entry.html);
          };
        }
        // The second story's page is gone on Sunday.
        const gone = new URL(urlOf(SPECS[1]));
        routes[`${gone.hostname} ${gone.pathname}`] = (req, res) => (
          res.writeHead(404),
          res.end("gone")
        );
        const fetcher = createFetcher({
          resolve: loopbackResolver().resolve,
          isAllowedAddress: onlyLoopback,
          allowedPorts: [String(server.port)],
          ca: tls.cert,
          limits: { hostIntervalMs: 0 },
          sourcePolicy: APPROVED_POLICY,
        });
        const dir = contentDir();
        const outcome = await preparePublication({
          ...result,
          policy: APPROVED_POLICY,
          config,
          fetcher,
          contentDir: dir,
          now: NOW,
        });
        assert.equal(outcome.status, "prepared");
        assert.deepEqual(
          outcome.dropped.map((d) => [d.id, d.reasons[0]]),
          [["s2", "SOURCE_UNAVAILABLE:HTTP_STATUS"]],
        );
        assert.equal(
          JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")).stories
            .length,
          4,
        );
      } finally {
        await server.close();
      }
    });
  },
);

// Optional: run 3's real draft has the public shape the site accepts, and is
// refused for publication because it was a dry run under a provisional policy
// (TECH_BRIEF_DRYRUN_DIR=<folder with report.json and draft-edition.json>).
const realDir = process.env.TECH_BRIEF_DRYRUN_DIR;
test(
  "real research output: public projection is site-compatible; publication of a dry run is refused",
  {
    skip:
      realDir && existsSync(join(realDir ?? "", "draft-edition.json"))
        ? false
        : "research output not provided",
  },
  async () => {
    const report = JSON.parse(
      readFileSync(join(realDir, "report.json"), "utf8"),
    );
    const draft = JSON.parse(
      readFileSync(join(realDir, "draft-edition.json"), "utf8"),
    );
    const pub = publicEdition(draft);
    assert.deepEqual(publicEditionProblems(pub), []);
    assert.equal(site.parseEdition(pub).stories.length, draft.stories.length);
    const text = serializeEdition(pub);
    for (const s of draft.stories)
      for (const v of s.evidence.verification)
        assert.ok(!text.includes(v.quote));
    assert.equal(
      await codeOf(
        preparePublication({
          report,
          draft,
          policy: APPROVED_POLICY,
          config,
          fetcher: fakeFetcher(new Map()),
          contentDir: contentDir(),
          now: NOW,
        }),
      ),
      "NOT_PRODUCTION",
    );
  },
);
