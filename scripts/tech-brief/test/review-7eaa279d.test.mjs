// Regression tests for the final-review failures of dry run run-7eaa279d.
// The fixture holds the four rejected stories as recorded in that run's
// report (verified claims, quotes, reviewer output) plus reconstructed drafts;
// see the fixture's "note". No network, no model calls.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { ATTRIBUTION_MARKERS, checkAttribution } from "../editorial.mjs";
import {
  ATTRIBUTION_RULE,
  FRENCH_TERMS_RULE,
  SUPPORT_RULE,
  WHY_IT_MATTERS_RULE,
  repairPrompt,
  reviewPrompt,
  writingPrompt,
} from "../prompts.mjs";
import {
  MAX_REVIEW_REPAIRS,
  loadConfig,
  passesReview,
  reviewRepairProblems,
} from "../research.mjs";
import { SCHEMAS, validateAgainstSchema } from "../schemas.mjs";
import { normalizeForMatch } from "../text.mjs";
import { checkBilingual, checkEditorial } from "../validate.mjs";
import { fixtureJson } from "./helpers.mjs";

const RUN = fixtureJson("run-7eaa279d-review.json");
const byKey = Object.fromEntries(RUN.stories.map((s) => [s.key, s]));
const storyOf = (s, text = s.draft) => ({
  ...structuredClone(text),
  evidence: { editorial: s.editorial },
});
// "<Name> <reporting verb>" or "<according to|selon|d'après> <Name>". (The
// marker list alone also matches nouns such as "Report".)
const attributed = (sentence, name, lang) => {
  const text = ` ${normalizeForMatch(sentence)} `;
  const org = normalizeForMatch(name);
  return ATTRIBUTION_MARKERS[lang].some((m) => {
    const marker = normalizeForMatch(m);
    return (
      text.includes(` ${org} ${marker} `) ||
      (["according to", "selon", "d'apres"].includes(marker) &&
        ["", "the ", "le ", "la ", "l'"].some((article) =>
          text.includes(` ${marker} ${article}${org}`),
        ))
    );
  });
};
const isFrench = (sentence, s) =>
  [s.draft.fr.headline, s.draft.fr.summary, s.draft.fr.whyItMatters].some(
    (field) => field.includes(sentence),
  );
// The run's verdicts in the current review schema (it recorded sentences only).
const asVerdict = (s, problem = "missing-attribution") => ({
  key: s.key,
  faithful: s.review.faithful,
  unsupportedSentences: s.review.unsupportedSentences.map((sentence) => ({
    sentence,
    problem,
    reason: "Not stated by the claims.",
  })),
  translationIssues: s.review.translationIssues,
  copyrightConcern: s.review.copyrightConcern,
});

test("run-7eaa279d: all four stories were verified vendor self-reports rejected only by the final reviewer", () => {
  assert.deepEqual(Object.keys(byKey), ["k4", "k5", "k6", "k7"]);
  for (const s of RUN.stories) {
    assert.ok(s.selfReportedBy, s.key);
    assert.equal(s.review.faithful, false);
    assert.equal(s.review.copyrightConcern, false);
    assert.ok(s.claims.filter((c) => c.verdict === "entailed").length >= 2);
  }
});

test("run-7eaa279d root cause: no flagged sentence repeats the attribution, and every summary carries it", () => {
  let flagged = 0;
  for (const s of RUN.stories) {
    for (const { sentence } of s.diagnosis) {
      flagged++;
      const lang = isFrench(sentence, s) ? "fr" : "en";
      assert.ok(
        !attributed(sentence, s.selfReportedBy, lang),
        `${s.key}: ${sentence}`,
      );
    }
    // The approved rule (checkAttribution: once per summary) was met, and
    // the helper above does recognise those attributions.
    assert.deepEqual(checkAttribution(storyOf(s)), [], s.key);
    for (const lang of ["en", "fr"])
      assert.ok(
        attributed(s.draft[lang].summary, s.selfReportedBy, lang),
        `${s.key} ${lang}`,
      );
  }
  assert.equal(flagged, 20);
});

test("run-7eaa279d diagnosis: 14 false positives, 3 borderline, 3 legitimate, plus one valid translation issue", () => {
  const all = RUN.stories.flatMap((s) =>
    s.diagnosis.map((d) => ({ ...d, key: s.key })),
  );
  const count = (v) => all.filter((d) => d.verdict === v).length;
  assert.deepEqual(
    [count("false-positive"), count("borderline"), count("legitimate")],
    [14, 3, 3],
  );
  // Every diagnosis cites claims the story actually verified.
  for (const d of all) {
    const entailed = byKey[d.key].claims
      .filter((c) => c.verdict === "entailed")
      .map((c) => c.id);
    for (const id of d.claims)
      assert.ok(entailed.includes(id), `${d.key} ${id}`);
  }
  // Canonical (k7) and Anthropic (k4) were rejected only for faithful text.
  for (const key of ["k4", "k7"])
    assert.ok(
      byKey[key].diagnosis.every((d) => d.verdict === "false-positive"),
    );
  // WordPress (k6): the headline overstates c1 and "block supports" is mistranslated.
  assert.equal(byKey.k6.review.translationIssues.length, 1);
  assert.match(byKey.k6.review.translationIssues[0], /block supports/);
  assert.match(
    byKey.k6.diagnosis.find((d) => d.verdict === "legitimate").sentence,
    /expands block supports/,
  );
});

test("run-7eaa279d drafts pass every deterministic check, so the reviewer was the only blocker", () => {
  for (const s of RUN.stories) {
    const story = storyOf(s);
    assert.deepEqual(checkBilingual(story).errors, [], s.key);
    assert.deepEqual(checkEditorial(story), [], s.key);
    assert.deepEqual(checkAttribution(story), [], s.key);
  }
});

test("invalid paraphrases and unsupported implications that deterministic checks catch", () => {
  const codes = (story) =>
    checkAttribution(story).map((e) => `${e.code}@${e.path}`);

  // Attribution removed from a summary: the per-summary rule still applies.
  const k7 = storyOf(byKey.k7);
  k7.en.summary = k7.en.summary.replace("Canonical announced Ubuntu", "Ubuntu");
  assert.deepEqual(codes(k7), ["ATTRIBUTION_MISSING@story.en.summary"]);

  // Presenting a self-report as independently established, in any field and language.
  for (const [lang, field, text] of [
    ["en", "headline", "Tests prove Ubuntu 26.10 is post-quantum ready"],
    ["en", "whyItMatters", "The new signing was independently verified."],
    [
      "en",
      "summary",
      "Canonical says the change has been proven in production.",
    ],
    [
      "fr",
      "summary",
      "Selon Canonical, les résultats ont été vérifiés de manière indépendante.",
    ],
    ["fr", "headline", "Ubuntu 26.10 prouve sa résistance post-quantique"],
    ["fr", "whyItMatters", "Ces gains sont désormais prouvés."],
  ]) {
    const story = storyOf(byKey.k7);
    story[lang][field] = text;
    assert.ok(
      codes(story).includes(`SELF_REPORT_OVERSTATED@story.${lang}.${field}`),
      text,
    );
  }

  // Reporting language and plain facts are not flagged.
  const plain = storyOf(byKey.k4);
  plain.en.whyItMatters =
    "Anthropic says the arrangement was confirmed with METR.";
  assert.deepEqual(codes(plain), []);

  // The rule applies to self-reports only.
  const independent = storyOf(byKey.k7);
  independent.evidence.editorial = {
    vendorSelfReport: false,
    attributedTo: null,
  };
  independent.en.headline = "Tests prove Ubuntu 26.10 is post-quantum ready";
  assert.deepEqual(codes(independent), []);

  // A number changed in translation (WordPress: around 140 pull requests).
  const k6 = storyOf(byKey.k6);
  k6.fr.summary = k6.fr.summary.replace("140", "14");
  assert.ok(
    checkBilingual(k6).errors.some((e) => e.code === "NUMBER_MISMATCH"),
  );
});

test("writer, repair and reviewer share one support, attribution, 'why it matters' and French-terms rule", () => {
  const stories = RUN.stories.map((s) => ({
    key: s.key,
    publisher: s.publisher,
    selfReportedBy: s.selfReportedBy,
    claims: s.claims
      .filter((c) => c.verdict === "entailed")
      .map((c) => ({ id: c.id, text: c.text })),
    en: s.draft.en,
    fr: s.draft.fr,
  }));
  const prompts = {
    writing: writingPrompt({ stories }).instructions,
    repair: repairPrompt({ stories }).instructions,
    review: reviewPrompt({ stories }).instructions,
  };
  for (const [name, text] of Object.entries(prompts))
    for (const rule of [
      SUPPORT_RULE,
      ATTRIBUTION_RULE,
      WHY_IT_MATTERS_RULE,
      FRENCH_TERMS_RULE,
    ])
      assert.ok(text.includes(rule), `${name} lacks: ${rule.slice(0, 40)}`);

  // The per-sentence reading that rejected run-7eaa279d is gone; the
  // substance of the rule (never independent, always attributed) remains.
  assert.ok(!prompts.review.includes("does not say who reported them"));
  assert.match(prompts.review, /Judge attribution for the entry as a whole/);
  assert.match(
    prompts.review,
    /Do not list a sentence only because it does not repeat the attribution/,
  );
  assert.match(prompts.review, /presented-as-independent/);
  assert.match(SUPPORT_RULE, /existing versus new/);
  assert.match(SUPPORT_RULE, /can versus must/);
  assert.match(SUPPORT_RULE, /changes who does what/);
  assert.match(FRENCH_TERMS_RULE, /block supports/);
  assert.match(prompts.repair, /Never add facts or detail to answer a problem/);
});

test("the review schema requires a problem type and reason for every rejected sentence", () => {
  const verdict = asVerdict(byKey.k6, "overstates");
  assert.deepEqual(
    validateAgainstSchema({ stories: [verdict] }, SCHEMAS.review),
    [],
  );
  // The run's shape (bare strings) and unknown problem types are refused.
  assert.ok(
    validateAgainstSchema(
      { stories: [{ ...verdict, unsupportedSentences: ["A sentence."] }] },
      SCHEMAS.review,
    ).length > 0,
  );
  const unknown = structuredClone(verdict);
  unknown.unsupportedSentences[0].problem = "style";
  assert.ok(
    validateAgainstSchema({ stories: [unknown] }, SCHEMAS.review).length,
  );
});

test("review repair: which rejections a rewrite may address, and what it is told", () => {
  for (const s of RUN.stories) {
    const verdict = asVerdict(s);
    assert.equal(passesReview(verdict), false, s.key);
    const problems = reviewRepairProblems(verdict);
    assert.equal(
      problems.length,
      s.review.unsupportedSentences.length + s.review.translationIssues.length,
    );
    for (const sentence of s.review.unsupportedSentences)
      assert.ok(
        problems.some((p) => p.includes(sentence)),
        sentence,
      );
  }
  assert.match(
    reviewRepairProblems(asVerdict(byKey.k6)).at(-1),
    /^FRENCH: .*block supports/,
  );

  const clean = {
    key: "k1",
    faithful: true,
    unsupportedSentences: [],
    translationIssues: [],
    copyrightConcern: false,
  };
  assert.equal(passesReview(clean), true);
  assert.equal(reviewRepairProblems(clean), null);
  // Not repairable: no verdict, a copyright concern, or nothing actionable.
  assert.equal(reviewRepairProblems(undefined), null);
  assert.equal(reviewRepairProblems({ missing: true }), null);
  assert.equal(
    reviewRepairProblems({ ...asVerdict(byKey.k4), copyrightConcern: true }),
    null,
  );
  assert.equal(reviewRepairProblems({ ...clean, faithful: false }), null);
  assert.equal(passesReview({ ...clean, faithful: false }), false);
  assert.equal(passesReview({ ...clean, copyrightConcern: true }), false);
  // Reviewer text is bounded before it reaches the repair prompt.
  const long = reviewRepairProblems({
    ...clean,
    faithful: false,
    unsupportedSentences: [
      {
        sentence: "x".repeat(5000),
        problem: "overstates",
        reason: "y".repeat(5000),
      },
    ],
  });
  assert.ok(long[0].length < 800);
});

test("review repair is limited to one attempt in config and in code", async () => {
  const config = await loadConfig();
  assert.equal(config.limits.reviewRepairAttempts, 1);
  assert.equal(MAX_REVIEW_REPAIRS, 1);
  // Budget ceilings are unchanged.
  assert.equal(config.budget.perRunUsd, 0.75);
  assert.equal(config.budget.monthlyUsd, 4);
});

// Optional: compare the fixture with the saved report when it is available
// (TECH_BRIEF_DRYRUN_REPORT=<path to run-7eaa279d report.json>).
const reportPath = process.env.TECH_BRIEF_DRYRUN_REPORT;
test(
  "the fixture matches the saved run-7eaa279d report",
  {
    skip: reportPath && existsSync(reportPath) ? false : "report not provided",
  },
  () => {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.runId, "run-7eaa279d");
    for (const s of RUN.stories) {
      const c = report.candidates.find((x) => x.key === s.key);
      assert.equal(c.reason, "REVIEW_REJECTED");
      assert.deepEqual(c.review, s.review);
      assert.deepEqual(
        c.verification.claims.map((cl) => [
          cl.id,
          cl.text,
          cl.quote,
          cl.verdict,
        ]),
        s.claims.map((cl) => [cl.id, cl.text, cl.quote, cl.verdict]),
      );
    }
  },
);
