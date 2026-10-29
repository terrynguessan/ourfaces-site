// Editorial corrections (corrections.mjs and their use in publish.mjs and the
// preview), offline: bilingual text revisions and exclusions bound to one
// research result, evidence and number checks against the live pages, full
// revalidation, approval digests, warning visibility, the before/after review
// and the local CLI. Articles are synthetic pages served by a fake fetcher.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { correctionsInput } from "../automation.mjs";
import {
  CORRECTIONS_FORMAT,
  MAX_CORRECTIONS_BYTES,
  SECRET_LIMIT_BYTES,
  correctionsDigest,
  parseCorrections,
} from "../corrections.mjs";
import {
  buildPreview,
  generateReviewerKeyPair,
  openPreview,
  parseReviewerPrivateKey,
  parseReviewerPublicKey,
  previewProblems,
  renderPreview,
  sealPreview,
} from "../preview.mjs";
import {
  EMPTY_EDITION,
  PublishError,
  contentDigest,
  preparePublication,
  publicEdition,
  serializeEdition,
} from "../publish.mjs";
import {
  REHEARSAL_RUN_ID,
  fixtureFetcher,
  rehearsalClock,
  rehearsalResult,
} from "../rehearsal.mjs";
import { loadConfig } from "../research.mjs";
import { addDays, loadSourcePolicy } from "../validate.mjs";
import { fixtureJson } from "./helpers.mjs";

const config = await loadConfig();
// TEST-ONLY approved copy of the source lists.
const APPROVED = Object.freeze({
  ...(await loadSourcePolicy(new URL("../sources.json", import.meta.url))),
  status: "approved",
});
const EDITION = "2026-10-24";
const NOW = rehearsalClock(EDITION);
const CLI = fileURLToPath(new URL("../corrections.mjs", import.meta.url));
const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
const HANDOFF = Object.freeze({
  reservationId: "gh-9100000001-1",
  researchRunId: REHEARSAL_RUN_ID,
  workflowRunId: 9100000001,
  runAttempt: 1,
  artifactId: 4100000001,
  bundleDigest: "ab".repeat(32),
});
const FOURTH = fixtureJson("valid-edition.json").stories[3]; // French source
const FOURTH_PARAGRAPHS = [
  "Un projet pilote transfrontalier va tester l’acceptation des portefeuilles d’identité numérique d’un État membre par les services d’un autre État.",
  "Les administrations et plusieurs entreprises privées participeront aux essais, qui s’appuieront sur une spécification technique partagée.",
  "Les résultats doivent orienter les règles d’interopérabilité que la Commission prévoit de publier l’an prochain.",
];

/** The rehearsal research result plus a fourth (French-language) story: four stories, four categories. */
function fourStories({ extraText = "", dateSuffix = "T12:00:00Z" } = {}) {
  // Copies: the rehearsal stories share their text objects with a module fixture.
  const { pages, report, draft } = rehearsalResult(EDITION);
  const result = {
    pages,
    report: structuredClone(report),
    draft: structuredClone(draft),
  };
  const url = "https://news.rehearsal-delta.example/rehearsal/story-4";
  const date = addDays(EDITION, -4);
  result.pages.set(
    url,
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${FOURTH.sourceHeadline}</title>
<meta property="og:title" content="${FOURTH.sourceHeadline}"><meta property="og:site_name" content="Rehearsal Source Delta">
<meta property="article:published_time" content="${date}T08:00:00+02:00"><link rel="canonical" href="${url}"></head>
<body><main><article><h1>${FOURTH.sourceHeadline}</h1>${FOURTH_PARAGRAPHS.map((p) => `<p>${p}</p>`).join("")}</article></main></body></html>`,
  );
  const claims = [0, 2].map((p, n) => ({
    id: `c${n + 1}`,
    text: `Synthetic claim ${n + 1}`,
    quote: FOURTH_PARAGRAPHS[p],
    paragraphId: `p${p + 1}`,
    quoteFound: true,
    verdict: "entailed",
  }));
  result.draft.stories.push({
    id: "s4",
    category: FOURTH.category,
    url,
    publisher: "Rehearsal Source Delta",
    sourcePublishedOn: date,
    sourceHeadline: FOURTH.sourceHeadline,
    sourceHeadlineLang: "fr",
    en: structuredClone(FOURTH.en),
    fr: structuredClone(FOURTH.fr),
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
  result.report.candidates.push({
    key: "k4",
    url,
    status: "selected",
    storyId: "s4",
    verification: { status: "verified", distinctSupported: 2, claims },
  });
  result.report.selected.push("k4");
  // Optional page changes for the warning tests (first story's page).
  const first = result.draft.stories[0].url;
  result.pages.set(
    first,
    result.pages
      .get(first)
      .replace(/T12:00:00Z/, dateSuffix)
      .replace(
        "</article>",
        extraText ? `<p>${extraText}</p></article>` : "</article>",
      ),
  );
  return result;
}

const GAMMA_QUOTE =
  "On three large monorepos used for benchmarking, repeated checks after small edits completed up to four times faster.";
const REVISED_WHY = {
  en: "Developers working in large monorepos can rerun checks after small edits up to four times faster, which shortens local feedback.",
  fr: "Les développeurs qui travaillent dans de grands monodépôts peuvent relancer les vérifications après de petites modifications jusqu’à quatre fois plus vite, ce qui raccourcit le retour en local.",
};
const originalDigest = (draft) =>
  contentDigest(serializeEdition(publicEdition(draft)));

/** A corrections document for `result` (revising s3's why-it-matters by default), as file text. */
function correctionsText(result, { corrections, basis = {}, ...top } = {}) {
  const s3 = result.draft.stories[2];
  return `${JSON.stringify(
    {
      format: CORRECTIONS_FORMAT,
      edition: EDITION,
      basis: {
        researchRunId: HANDOFF.researchRunId,
        workflowRunId: HANDOFF.workflowRunId,
        runAttempt: HANDOFF.runAttempt,
        artifactId: HANDOFF.artifactId,
        bundleDigest: HANDOFF.bundleDigest,
        originalDigest: originalDigest(result.draft),
        ...basis,
      },
      corrections: corrections ?? [
        {
          storyId: "s3",
          action: "revise",
          reasons: ["WHY_IT_MATTERS"],
          note: "The original why-it-matters did not say who benefits.",
          evidence: [{ url: s3.url, quote: GAMMA_QUOTE }],
          text: {
            en: { whyItMatters: REVISED_WHY.en },
            fr: { whyItMatters: REVISED_WHY.fr },
          },
        },
      ],
      ...top,
    },
    null,
    2,
  )}\n`;
}

function contentDir() {
  const dir = mkdtempSync(join(tmpdir(), "tb-corrections-"));
  writeFileSync(join(dir, "latest.json"), serializeEdition(EMPTY_EDITION));
  return dir;
}
const snapshot = (dir) =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true })
      .map(String)
      .sort()
      .map((name) => {
        try {
          return [name, readFileSync(join(dir, name), "utf8")];
        } catch {
          return [name, "<folder>"];
        }
      }),
  );
const prepare = (result, args = {}) =>
  preparePublication({
    report: result.report,
    draft: result.draft,
    policy: APPROVED,
    config,
    fetcher: fixtureFetcher(result.pages),
    contentDir: contentDir(),
    now: NOW,
    trigger: "manual",
    handoff: HANDOFF,
    ...args,
  });
async function errorOf(promise) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PublishError) return error;
    throw error;
  }
  return { code: "NO_ERROR" };
}
const codeOf = async (promise) => (await errorOf(promise)).code;

// --- Corrected content -------------------------------------------------------------------

test("a corrected preview changes only the revised public text, in both languages, and leaves the research result untouched", async () => {
  const result = fourStories();
  const before = JSON.stringify({ report: result.report, draft: result.draft });
  const uncorrected = await prepare(result, { write: false });
  const text = correctionsText(result);
  const corrected = await prepare(result, { write: false, corrections: text });
  assert.equal(corrected.status, "checked");
  assert.equal(
    JSON.stringify({ report: result.report, draft: result.draft }),
    before,
  );

  const a = JSON.parse(uncorrected.text);
  const b = JSON.parse(corrected.text);
  assert.equal(b.stories[2].en.whyItMatters, REVISED_WHY.en);
  assert.equal(b.stories[2].fr.whyItMatters, REVISED_WHY.fr);
  // Everything else, including the story's facts and the other stories, is identical.
  b.stories[2].en.whyItMatters = a.stories[2].en.whyItMatters;
  b.stories[2].fr.whyItMatters = a.stories[2].fr.whyItMatters;
  assert.deepEqual(b, a);
  assert.equal(uncorrected.contentDigest, originalDigest(result.draft));
  assert.notEqual(corrected.contentDigest, uncorrected.contentDigest);

  // Provenance: which document, applied to which content, changed what.
  assert.deepEqual(corrected.corrections, {
    correctionsDigest: createHash("sha256").update(text).digest("hex"),
    originalDigest: uncorrected.contentDigest,
    revised: ["s3"],
    excluded: [],
  });
  assert.equal(
    corrected.corrections.correctionsDigest,
    correctionsDigest(text),
  );
  assert.deepEqual(corrected.excluded, []);
  const [entry] = corrected.correctionReview;
  assert.equal(
    entry.before.en.whyItMatters,
    result.draft.stories[2].en.whyItMatters,
  );
  assert.equal(entry.after.fr.whyItMatters, REVISED_WHY.fr);
  // The same document always gives the same content.
  const again = await prepare(fourStories(), {
    write: false,
    corrections: text,
  });
  assert.equal(again.contentDigest, corrected.contentDigest);
  // An uncorrected run has no correction fields at all.
  assert.equal(uncorrected.corrections, undefined);
  assert.equal(uncorrected.correctionReview, undefined);
});

test("justified exclusions are applied, and the story count rule still holds", async () => {
  const result = fourStories();
  const exclude = (storyId) => ({
    storyId,
    action: "exclude",
    reasons: ["UNVERIFIABLE_CLAIM"],
    note: "The central claim could not be confirmed in a primary source.",
    evidence: [],
  });
  const out = await prepare(result, {
    write: false,
    corrections: correctionsText(result, { corrections: [exclude("s4")] }),
  });
  assert.deepEqual(
    JSON.parse(out.text).stories.map((s) => s.id),
    ["s1", "s2", "s3"],
  );
  assert.deepEqual(out.excluded, ["s4"]);
  assert.deepEqual(out.dropped, []);
  assert.equal(out.correctionReview[0].before, null);
  assert.equal(
    await codeOf(
      prepare(result, {
        write: false,
        corrections: correctionsText(result, {
          corrections: [exclude("s3"), exclude("s4")],
        }),
      }),
    ),
    "INSUFFICIENT_STORIES",
  );
  // Exclusion evidence, when cited, is checked like any other quote.
  const cited = {
    ...exclude("s4"),
    evidence: [
      {
        url: result.draft.stories[3].url,
        quote: "Cette phrase ne figure pas dans l’article.",
      },
    ],
  };
  assert.equal(
    await codeOf(
      prepare(result, {
        write: false,
        corrections: correctionsText(result, { corrections: [cited] }),
      }),
    ),
    "CORRECTION_UNSUPPORTED",
  );
});

// --- Approval ------------------------------------------------------------------------------

test("corrected content is published only with the approved digest of the corrected preview", async () => {
  const result = fourStories();
  const text = correctionsText(result);
  const preview = await prepare(result, { write: false, corrections: text });
  const original = await prepare(result, { write: false });

  // A corrected write always needs an approval, even when automation does not require one.
  let fetches = 0;
  const counting = {
    fetchArticle: async () => {
      fetches++;
      return { ok: false, code: "HTTP_STATUS" };
    },
  };
  const dir = contentDir();
  const untouched = snapshot(dir);
  assert.equal(
    await codeOf(
      prepare(result, {
        contentDir: dir,
        corrections: text,
        fetcher: counting,
      }),
    ),
    "APPROVAL_REQUIRED",
  );
  assert.equal(fetches, 0);
  // The uncorrected digest, or any other, is refused after every check.
  for (const digest of [original.contentDigest, "0".repeat(64)])
    assert.equal(
      await codeOf(
        prepare(result, {
          contentDir: dir,
          corrections: text,
          approvedDigest: digest,
          requireApproval: true,
        }),
      ),
      "APPROVAL_MISMATCH",
    );
  // A corrections file edited after the preview needs a new review.
  const edited = text.replace(
    "shortens local feedback",
    "speeds up local feedback",
  );
  assert.notEqual(edited, text);
  assert.equal(
    await codeOf(
      prepare(result, {
        contentDir: dir,
        corrections: edited,
        approvedDigest: preview.contentDigest,
        requireApproval: true,
      }),
    ),
    "APPROVAL_MISMATCH",
  );
  // Without the corrections, the approved corrected digest does not match either.
  assert.equal(
    await codeOf(
      prepare(result, {
        contentDir: dir,
        approvedDigest: preview.contentDigest,
        requireApproval: true,
      }),
    ),
    "APPROVAL_MISMATCH",
  );
  assert.deepEqual(snapshot(dir), untouched);

  // The approved digest publishes exactly the corrected preview text.
  const ok = await prepare(result, {
    contentDir: dir,
    corrections: text,
    approvedDigest: preview.contentDigest,
    requireApproval: true,
  });
  assert.equal(ok.status, "prepared");
  assert.equal(readFileSync(join(dir, "latest.json"), "utf8"), preview.text);
  assert.equal(
    readFileSync(join(dir, "editions", `${EDITION}.json`), "utf8"),
    preview.text,
  );
  assert.equal(ok.corrections.correctionsDigest, correctionsDigest(text));
});

// --- Integrity and provenance ------------------------------------------------------------------

test("corrections are bound to one research result and to the exact content that was reviewed", async () => {
  const result = fourStories();
  const cases = [
    ["researchRunId", { basis: { researchRunId: "run-00000000" } }],
    ["workflowRunId", { basis: { workflowRunId: 9100000002 } }],
    ["runAttempt", { basis: { runAttempt: 2 } }],
    ["artifactId", { basis: { artifactId: 4100000002 } }],
    ["bundleDigest", { basis: { bundleDigest: "cd".repeat(32) } }],
    ["originalDigest", { basis: { originalDigest: "ef".repeat(32) } }],
    ["edition", { edition: "2026-10-17" }],
  ];
  for (const [name, change] of cases)
    assert.equal(
      await codeOf(
        prepare(result, {
          write: false,
          corrections: correctionsText(result, change),
        }),
      ),
      "CORRECTION_BASIS",
      name,
    );
  // No handoff, no corrections.
  assert.equal(
    await codeOf(
      prepare(result, {
        write: false,
        handoff: null,
        corrections: correctionsText(result),
      }),
    ),
    "CORRECTION_BASIS",
  );
  // A handoff and document that agree with each other but not with the opened report.
  const elsewhere = { ...HANDOFF, researchRunId: "run-0000cafe" };
  assert.equal(
    await codeOf(
      prepare(result, {
        write: false,
        handoff: elsewhere,
        corrections: correctionsText(result, {
          basis: { researchRunId: "run-0000cafe" },
        }),
      }),
    ),
    "CORRECTION_BASIS",
  );
  // Research that differs from what was reviewed (one story's text changed) is refused.
  const changed = fourStories();
  changed.draft.stories[0].en.summary += " Extra.";
  assert.equal(
    await codeOf(
      prepare(changed, { write: false, corrections: correctionsText(result) }),
    ),
    "CORRECTION_BASIS",
  );
});

test("only well-formed, evidence-backed text corrections are accepted", async () => {
  const result = fourStories();
  const s3 = result.draft.stories[2];
  const base = JSON.parse(correctionsText(result)).corrections[0];
  const revise = (change) => [{ ...structuredClone(base), ...change }];
  const text = (en, fr = REVISED_WHY.fr) => ({
    text: { en: { whyItMatters: en }, fr: { whyItMatters: fr } },
  });
  const invalid = [
    ["a non-text field", revise({ url: "https://example.com/other" })],
    [
      "a protected story field",
      revise({
        text: {
          en: { url: "https://x.example/a" },
          fr: { url: "https://x.example/a" },
        },
      }),
    ],
    [
      "English only",
      revise({ text: { en: { whyItMatters: REVISED_WHY.en }, fr: {} } }),
    ],
    [
      "different fields per language",
      revise({
        text: {
          en: { whyItMatters: REVISED_WHY.en },
          fr: { summary: REVISED_WHY.fr },
        },
      }),
    ],
    ["no evidence", revise({ evidence: [] })],
    [
      "evidence without https",
      revise({
        evidence: [
          { url: "http://news.rehearsal-gamma.example/x", quote: GAMMA_QUOTE },
        ],
      }),
    ],
    ["a reason from another list", revise({ reasons: ["UNVERIFIABLE_CLAIM"] })],
    ["an unknown action", revise({ action: "replace" })],
    ["an empty note", revise({ note: " " })],
    [
      "a bidi control character",
      revise(text(`${REVISED_WHY.en}${String.fromCharCode(0x202e)}`)),
    ],
    [
      "an exclusion with text",
      [{ ...base, action: "exclude", reasons: ["EDITORIAL_JUDGMENT"] }],
    ],
    ["a duplicate story", [base, base]],
    ["no corrections", []],
  ];
  for (const [name, corrections] of invalid)
    assert.equal(
      await codeOf(
        prepare(result, {
          write: false,
          corrections: correctionsText(result, { corrections }),
        }),
      ),
      "CORRECTIONS_INVALID",
      name,
    );
  for (const [name, doc] of [
    ["not JSON", "{"],
    [
      "another format",
      correctionsText(result).replace(
        CORRECTIONS_FORMAT,
        "ourfaces-tech-brief-corrections/9",
      ),
    ],
    [
      "an extra top-level field",
      correctionsText(result, { reviewer: "someone" }),
    ],
    [
      "too large",
      correctionsText(result).replace(
        '"note": "',
        `"note": "${"x".repeat(70_000)}`,
      ),
    ],
  ])
    assert.equal(
      await codeOf(prepare(result, { write: false, corrections: doc })),
      "CORRECTIONS_INVALID",
      name,
    );
  assert.throws(() => parseCorrections(""), { code: "CORRECTIONS_INVALID" });

  // Stories can be corrected, never added.
  assert.equal(
    await codeOf(
      prepare(result, {
        write: false,
        corrections: correctionsText(result, {
          corrections: revise({ storyId: "s9" }),
        }),
      }),
    ),
    "CORRECTION_UNKNOWN_STORY",
  );
  assert.equal(
    await codeOf(
      prepare(result, {
        write: false,
        corrections: correctionsText(result, {
          corrections: revise(text(s3.en.whyItMatters, REVISED_WHY.fr)),
        }),
      }),
    ),
    "CORRECTION_NOOP",
  );

  // Evidence and figures are checked against the live pages.
  const unsupported = [
    [
      "a quote not on the page",
      revise({
        evidence: [
          {
            url: s3.url,
            quote: "This sentence was never published by the source.",
          },
        ],
      }),
      "CORRECTION_QUOTE_NOT_FOUND:s3.evidence[0]",
    ],
    [
      "an unavailable evidence page",
      revise({
        evidence: [
          {
            url: "https://news.rehearsal-missing.example/a",
            quote: GAMMA_QUOTE,
          },
        ],
      }),
      "CORRECTION_EVIDENCE_UNAVAILABLE:s3.evidence[0]",
    ],
    [
      "an invented figure",
      revise(
        text(
          "Developers can rerun checks up to 9 times faster after small edits in large monorepos.",
          "Les développeurs peuvent relancer les vérifications jusqu’à 9 fois plus vite après de petites modifications dans de grands monodépôts.",
        ),
      ),
      "CORRECTION_NUMBER_UNSUPPORTED:s3.en.whyItMatters",
    ],
  ];
  for (const [name, corrections, problem] of unsupported) {
    const error = await errorOf(
      prepare(result, {
        write: false,
        corrections: correctionsText(result, { corrections }),
      }),
    );
    assert.equal(error.code, "CORRECTION_UNSUPPORTED", name);
    assert.ok(
      error.details.problems.includes(problem),
      `${name}: ${error.details.problems}`,
    );
  }
  // Copying the source into a revision fails the recheck: the correction is refused, the story is not dropped.
  const copied = await errorOf(
    prepare(result, {
      write: false,
      corrections: correctionsText(result, {
        corrections: revise(
          text(
            `Checks are faster. ${GAMMA_QUOTE}`,
            `Les vérifications sont plus rapides sur trois grands monodépôts, jusqu’à quatre fois.`,
          ),
        ),
      }),
    }),
  );
  assert.equal(copied.code, "CORRECTION_UNSUPPORTED");
  assert.ok(copied.details.problems.includes("COPYRIGHT_OVERLAP"));
});

test("corrected text is revalidated in full: wording, translation and bilingual numbers", async () => {
  const result = fourStories();
  const base = JSON.parse(correctionsText(result)).corrections[0];
  const cases = [
    [
      "EDITORIAL_WORDING",
      REVISED_WHY.en.replace(
        "Developers",
        "A revolutionary change: developers",
      ),
      REVISED_WHY.fr,
    ],
    ["FR_UNTRANSLATED", REVISED_WHY.en, REVISED_WHY.en],
    ["NUMBER_MISMATCH", REVISED_WHY.en.replace("four", "4"), REVISED_WHY.fr],
  ];
  for (const [code, en, fr] of cases) {
    const corrections = [
      { ...base, text: { en: { whyItMatters: en }, fr: { whyItMatters: fr } } },
    ];
    const error = await errorOf(
      prepare(result, {
        write: false,
        corrections: correctionsText(result, { corrections }),
      }),
    );
    assert.equal(error.code, "VALIDATION_FAILED", code);
    assert.ok(
      error.details.codes.includes(code),
      `${code}: ${error.details.codes}`,
    );
  }
});

// --- Warnings ----------------------------------------------------------------------------------

test("warnings found by the source recheck stay visible after corrections", async () => {
  const result = fourStories({
    dateSuffix: "T12:00",
    extraText:
      "The vendor also published the system prompt it uses for this feature.",
  });
  const plain = await prepare(result, { write: false });
  const corrected = await prepare(result, {
    write: false,
    corrections: correctionsText(result),
  });
  for (const outcome of [plain, corrected]) {
    assert.ok(
      outcome.warnings.includes("DATE_AMBIGUOUS"),
      outcome.warnings.join(),
    );
    assert.ok(
      outcome.warnings.includes("INSTRUCTION_TEXT_IN_SOURCE"),
      outcome.warnings.join(),
    );
  }
  assert.deepEqual(corrected.warnings, plain.warnings);
});

// --- Editorial preview -------------------------------------------------------------------------

test("the encrypted preview carries the before/after review; tampering with it is detected", async () => {
  const result = fourStories();
  const reviewer = generateReviewerKeyPair();
  const outcome = await prepare(result, {
    write: false,
    corrections: correctionsText(result),
  });
  const payload = buildPreview({ outcome, handoff: HANDOFF, now: NOW });
  const sealed = sealPreview({
    payload,
    recipient: parseReviewerPublicKey(reviewer.publicKey),
    now: NOW,
  });
  const opened = openPreview(
    sealed.bytes,
    parseReviewerPrivateKey(reviewer.privateKeyPem),
  );
  assert.deepEqual(opened.corrections, {
    ...outcome.corrections,
    stories: outcome.correctionReview,
  });
  const rendered = renderPreview(opened);
  assert.match(rendered, /Editorial corrections: 1 revised, 0 excluded/);
  assert.ok(
    rendered.includes(
      `[EN] whyItMatters BEFORE: ${result.draft.stories[2].en.whyItMatters}`,
    ),
  );
  assert.ok(rendered.includes(`[FR] whyItMatters AFTER:  ${REVISED_WHY.fr}`));
  assert.ok(rendered.includes(outcome.corrections.correctionsDigest));
  assert.ok(rendered.includes(`approved_digest = ${outcome.contentDigest}`));
  // Research evidence never enters the preview.
  assert.ok(!JSON.stringify(opened).includes("Synthetic rehearsal claim"));

  const tampered = (change) => {
    const p = structuredClone(opened);
    change(p.corrections);
    return previewProblems(p);
  };
  assert.deepEqual(previewProblems(opened), []);
  assert.ok(
    tampered((c) => (c.stories[0].action = "replace")).includes("corrections"),
  );
  assert.ok(tampered((c) => (c.revised = [])).includes("corrections"));
  assert.ok(
    tampered((c) => (c.correctionsDigest = "x")).includes("corrections"),
  );
  assert.ok(tampered((c) => (c.extra = 1)).includes("corrections"));
  assert.ok(
    tampered(
      (c) => (
        (c.excluded = ["s1"]),
        (c.stories[0] = {
          ...c.stories[0],
          action: "exclude",
          before: null,
          after: null,
        })
      ),
    ).includes("corrections"),
  );
  // An uncorrected preview says so.
  const plain = buildPreview({
    outcome: await prepare(result, { write: false }),
    handoff: HANDOFF,
    now: NOW,
  });
  assert.equal(plain.corrections, null);
  assert.match(renderPreview(plain), /Editorial corrections: none/);
});

// --- Local CLI ---------------------------------------------------------------------------------

test("CLI check binds to a decrypted preview, projects the corrected content and prints no story text", async () => {
  const result = fourStories();
  const plain = buildPreview({
    outcome: await prepare(result, { write: false }),
    handoff: HANDOFF,
    now: NOW,
  });
  const review = mkdtempSync(join(tmpdir(), "tb-corrections-review-"));
  writeFileSync(
    join(review, `editorial-preview-${EDITION}.json`),
    `${JSON.stringify(plain, null, 2)}\n`,
  );
  const text = correctionsText(result);
  const file = join(review, "corrections.json");
  writeFileSync(file, text);
  const out = join(mkdtempSync(join(tmpdir(), "tb-corrections-out-")), "check");
  const run = (args) =>
    spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  const ok = run([
    "check",
    "--corrections",
    file,
    "--review",
    review,
    "--out",
    out,
    "--offline",
  ]);
  assert.equal(ok.status, 0, ok.stdout);
  const report = JSON.parse(ok.stdout);
  const corrected = await prepare(result, { write: false, corrections: text });
  assert.equal(report.projectedContentDigest, corrected.contentDigest);
  assert.equal(report.correctionsDigest, correctionsDigest(text));
  assert.deepEqual(report.revised, ["s3"]);
  assert.ok(!ok.stdout.includes(REVISED_WHY.en));
  assert.equal(
    readFileSync(join(out, `latest-corrected-${EDITION}.json`), "utf8"),
    corrected.text,
  );
  assert.match(
    readFileSync(join(out, `corrections-review-${EDITION}.txt`), "utf8"),
    /\[FR\] whyItMatters AFTER: {2}Les développeurs/,
  );
  // Nothing is overwritten, and output never goes inside the repository.
  assert.equal(
    run([
      "check",
      "--corrections",
      file,
      "--review",
      review,
      "--out",
      out,
      "--offline",
    ]).status,
    4,
  );
  assert.equal(
    run([
      "check",
      "--corrections",
      file,
      "--review",
      review,
      "--out",
      join(REPOSITORY, "tmp-corrections"),
      "--offline",
    ]).status,
    1,
  );
  // Corrections for other research are refused locally too.
  const other = join(review, "other.json");
  writeFileSync(other, correctionsText(result, { basis: { artifactId: 1 } }));
  const refused = run([
    "check",
    "--corrections",
    other,
    "--review",
    review,
    "--out",
    `${out}-2`,
    "--offline",
  ]);
  assert.equal(refused.status, 4);
  assert.equal(JSON.parse(refused.stdout).code, "CORRECTION_BASIS");
});

// --- Hidden characters and size ----------------------------------------------------------------

test("hidden characters are refused in every free-text field, each by its own guard", async () => {
  const result = fourStories();
  const base = JSON.parse(correctionsText(result)).corrections[0];
  const char = (code) => String.fromCharCode(code);
  // Guard 1 (UNSAFE_CHARS) alone catches line breaks and tabs, which
  // cleanText turns into spaces; guard 2 (cleanText must change nothing but
  // spacing) alone catches zero-width characters and byte-order marks, which
  // UNSAFE_CHARS does not list. Bidi and other control characters hit both.
  const hidden = [
    ["line feed (guard 1)", char(0x0a)],
    ["tab (guard 1)", char(0x09)],
    ["carriage return (guard 1)", char(0x0d)],
    ["zero-width space (guard 2)", char(0x200b)],
    ["zero-width joiner (guard 2)", char(0x200d)],
    ["byte-order mark (guard 2)", char(0xfeff)],
    // JavaScript counts U+FEFF as whitespace: beside a space it once hid in
    // whitespace normalisation, so guard 2 checks each character on its own.
    ["byte-order mark beside a space (guard 2)", ` ${char(0xfeff)} `],
    ["zero-width space beside a space (guard 2)", ` ${char(0x200b)} `],
    ["decomposed accent (guard 2 and NFC)", `e${char(0x301)}`],
    // Visible, but NFC turns it into another character (U+00C5): NFC alone.
    ["angstrom sign (NFC required)", char(0x212b)],
    ["right-to-left override (both)", char(0x202e)],
    ["first-strong isolate (both)", char(0x2068)],
    ["null (both)", char(0x00)],
    ["next line, C1 (both)", char(0x85)],
  ];
  const places = {
    note: (c, s) => ({ ...c, note: `Reviewed${s}note.` }),
    quote: (c, s) => ({
      ...c,
      evidence: [
        {
          ...c.evidence[0],
          quote: `${GAMMA_QUOTE.slice(0, 30)}${s}${GAMMA_QUOTE.slice(30)}`,
        },
      ],
    }),
    "English text": (c, s) => ({
      ...c,
      text: {
        ...c.text,
        en: { whyItMatters: REVISED_WHY.en.replace("large", `large${s}`) },
      },
    }),
    "French text": (c, s) => ({
      ...c,
      text: {
        ...c.text,
        fr: { whyItMatters: REVISED_WHY.fr.replace("grands", `grands${s}`) },
      },
    }),
  };
  for (const [name, s] of hidden)
    for (const [place, put] of Object.entries(places)) {
      const doc = correctionsText(result, {
        corrections: [put(structuredClone(base), s)],
      });
      assert.throws(
        () => parseCorrections(doc),
        { code: "CORRECTIONS_INVALID" },
        `${name} in ${place}`,
      );
    }
  // French typography stays allowed: no-break spaces before punctuation and in numbers.
  const french = structuredClone(base);
  french.text.fr.whyItMatters = REVISED_WHY.fr.replace(
    ", ce qui",
    `${char(0xa0)}; ce qui`,
  );
  french.note = `Checked on 1${char(0x202f)}200 lines.`;
  assert.doesNotThrow(() =>
    parseCorrections(correctionsText(result, { corrections: [french] })),
  );
});

test("the corrections document fits a GitHub secret once base64-encoded", () => {
  assert.ok(Math.ceil(MAX_CORRECTIONS_BYTES / 3) * 4 <= SECRET_LIMIT_BYTES);
  const result = fourStories();
  // A document whose base64 form would not fit is refused before parsing.
  const padding = " ".repeat(MAX_CORRECTIONS_BYTES);
  assert.throws(
    () => parseCorrections(`${correctionsText(result)}${padding}`),
    {
      code: "CORRECTIONS_INVALID",
    },
  );
});

// --- Workflow inputs (use_corrections, corrections_digest) -------------------------------------

test("corrections are used only with use_corrections=true, in a manual dispatch, with the exact digest", () => {
  const text = correctionsText(fourStories());
  const digest = correctionsDigest(text);
  const input = (args) =>
    correctionsInput({
      event: "workflow_dispatch",
      use: "true",
      text,
      expectedDigest: digest,
      ...args,
    });
  assert.equal(input({}), text);
  // Off (the default, and every schedule): nothing is used, and nothing may be supplied.
  for (const use of ["false", "", null, undefined])
    assert.equal(
      correctionsInput({
        event: "schedule",
        use,
        text: null,
        expectedDigest: "",
      }),
      null,
      String(use),
    );
  assert.equal(
    correctionsInput({
      event: "workflow_dispatch",
      use: "false",
      text: "",
      expectedDigest: null,
    }),
    null,
  );
  const refused = [
    [{ use: "false" }, "CORRECTIONS_UNEXPECTED"],
    [{ use: "false", text: null }, "CORRECTIONS_UNEXPECTED"],
    [{ use: "TRUE" }, "CORRECTIONS_FLAG"],
    [{ use: "1" }, "CORRECTIONS_FLAG"],
    [{ event: "schedule" }, "CORRECTIONS_NOT_MANUAL"],
    [{ event: "push" }, "CORRECTIONS_NOT_MANUAL"],
    [{ text: "" }, "CORRECTIONS_MISSING"],
    [{ text: null }, "CORRECTIONS_MISSING"],
    [{ expectedDigest: "" }, "CORRECTIONS_DIGEST_REQUIRED"],
    [{ expectedDigest: digest.toUpperCase() }, "CORRECTIONS_DIGEST_REQUIRED"],
    [{ expectedDigest: "0".repeat(64) }, "CORRECTIONS_DIGEST_MISMATCH"],
    [{ text: `${text} ` }, "CORRECTIONS_DIGEST_MISMATCH"],
  ];
  for (const [args, code] of refused)
    assert.throws(
      () => input(args),
      { code },
      JSON.stringify(args).slice(0, 80),
    );
});

test("CLI: corrections are refused before the ledger or bundle is read, and logs carry no corrections text", () => {
  const AUTOMATION = fileURLToPath(
    new URL("../automation.mjs", import.meta.url),
  );
  const text = correctionsText(fourStories());
  const dir = mkdtempSync(join(tmpdir(), "tb-corrections-cli-"));
  const file = join(dir, "corrections.json");
  writeFileSync(file, text);
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(GITHUB_|TECH_BRIEF_|OPENAI_)/.test(k),
    ),
  );
  // No ledger, bundle or key exists here: any refusal below happens before they are needed.
  const run = (command, args, event = "workflow_dispatch") => {
    const r = spawnSync(
      process.execPath,
      [
        AUTOMATION,
        command,
        "--ledger-dir",
        join(dir, "missing"),
        "--edition",
        EDITION,
        "--out-dir",
        join(dir, "out"),
        ...args,
      ],
      {
        encoding: "utf8",
        env: {
          ...clean,
          GITHUB_EVENT_NAME: event,
          TECH_BRIEF_REVIEWER_PUBLIC_KEY: generateReviewerKeyPair().publicKey,
        },
      },
    );
    assert.ok(
      !r.stdout.includes(REVISED_WHY.en) && !r.stderr.includes(REVISED_WHY.en),
    );
    assert.ok(
      !r.stdout.includes("whyItMatters") && !r.stderr.includes("whyItMatters"),
    );
    return { status: r.status, code: JSON.parse(r.stdout).code };
  };
  const digest = correctionsDigest(text);
  for (const command of ["preview", "sunday-prepare"]) {
    const cases = [
      [
        [
          "--use-corrections",
          "false",
          "--corrections",
          file,
          "--corrections-digest",
          "",
        ],
        "CORRECTIONS_UNEXPECTED",
      ],
      [
        [
          "--use-corrections",
          "false",
          "--corrections",
          "",
          "--corrections-digest",
          digest,
        ],
        "CORRECTIONS_UNEXPECTED",
      ],
      [["--corrections", file], "CORRECTIONS_UNEXPECTED"],
      [
        [
          "--use-corrections",
          "true",
          "--corrections",
          file,
          "--corrections-digest",
          "",
        ],
        "CORRECTIONS_DIGEST_REQUIRED",
      ],
      [
        [
          "--use-corrections",
          "true",
          "--corrections",
          file,
          "--corrections-digest",
          "0".repeat(64),
        ],
        "CORRECTIONS_DIGEST_MISMATCH",
      ],
      [
        [
          "--use-corrections",
          "true",
          "--corrections",
          "",
          "--corrections-digest",
          digest,
        ],
        "CORRECTIONS_MISSING",
      ],
    ];
    for (const [args, code] of cases)
      assert.deepEqual(
        run(command, args),
        { status: 4, code },
        `${command} ${args.join(" ")}`,
      );
    assert.deepEqual(
      run(
        command,
        [
          "--use-corrections",
          "true",
          "--corrections",
          file,
          "--corrections-digest",
          digest,
        ],
        "schedule",
      ),
      { status: 4, code: "CORRECTIONS_NOT_MANUAL" },
    );
    // Accepted corrections (or none) get past the gate and only then need the ledger.
    for (const args of [
      [
        "--use-corrections",
        "true",
        "--corrections",
        file,
        "--corrections-digest",
        digest,
      ],
      [
        "--use-corrections",
        "false",
        "--corrections",
        "",
        "--corrections-digest",
        "",
      ],
    ]) {
      const r = run(command, args);
      assert.equal(r.status, 4);
      assert.ok(!r.code.startsWith("CORRECTIONS_"), `${command}: ${r.code}`);
    }
  }
});
