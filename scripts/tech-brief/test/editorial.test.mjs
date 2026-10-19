// F5: deterministic editorial classification and attribution of vendor
// self-reports. Promotional means advertising, marketing, hype or too little
// technical substance; a company reporting results about its own technology
// is accepted and attributed, never rejected for that alone.

import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTRIBUTION_MARKERS,
  CONTENT_TYPES,
  EDITORIAL_POLICY,
  checkAttribution,
  classifyEditorial,
  mentions,
} from "../editorial.mjs";
import { SCHEMAS } from "../schemas.mjs";

const facets = (extra = {}) => ({
  contentType: "independent-reporting",
  sponsoredOrPaid: false,
  technicalSubstance: "substantial",
  unsupportedHype: false,
  vendorSelfReport: false,
  reportingOrganization: "",
  promotionalEvidence: "",
  ...extra,
});

// Source facts for the article rejected as PROMOTIONAL in run-26e47111
// (https://www.anthropic.com/research/designing-efficient-quantum-circuits).
const QUANTUM = {
  publisher: "Anthropic",
  sourceSite: "anthropic.com",
  sourceKind: "vendor",
};

test("the run-26e47111 quantum-circuit article is vendor research, accepted and attributed", () => {
  const result = classifyEditorial(
    facets({
      contentType: "original-research",
      vendorSelfReport: true,
      reportingOrganization: "Anthropic",
    }),
    QUANTUM,
  );
  assert.equal(result.promotional, false);
  assert.equal(result.promotionalCode, null);
  assert.equal(result.promotionalReason, null);
  assert.equal(result.vendorSelfReport, true);
  assert.deepEqual(result.vendorSelfReportSignals, ["model", "source-policy"]);
  assert.equal(result.attributedTo, "Anthropic");
  assert.equal(result.attributionBasis, "publisher-name");
});

test("legitimate vendor-published research and engineering reports are accepted", () => {
  for (const contentType of [
    "original-research",
    "engineering-report",
    "product-announcement",
    "independent-reporting",
    "other",
  ]) {
    for (const vendorSelfReport of [true, false]) {
      const result = classifyEditorial(
        facets({ contentType, vendorSelfReport }),
        { publisher: "Example Labs" },
      );
      assert.equal(
        result.promotional,
        false,
        `${contentType}, self-report ${vendorSelfReport}`,
      );
    }
  }
});

test("a vendor reporting positive results about its own technology is never rejected for that alone", () => {
  const positive = facets({
    contentType: "engineering-report",
    vendorSelfReport: true,
    reportingOrganization: "Example Labs",
  });
  const asVendor = classifyEditorial(positive, {
    publisher: "Example Labs",
    sourceKind: "vendor-engineering",
  });
  const asIndependent = classifyEditorial(
    { ...positive, vendorSelfReport: false },
    { publisher: "Example Labs" },
  );
  assert.equal(asVendor.promotional, asIndependent.promotional);
  assert.equal(asVendor.promotional, false);
  assert.equal(asVendor.vendorSelfReport, true);
  assert.equal(asIndependent.vendorSelfReport, false);
});

test("clearly sponsored or paid content is rejected, whatever its substance", () => {
  for (const contentType of CONTENT_TYPES) {
    const result = classifyEditorial(
      facets({ contentType, sponsoredOrPaid: true }),
    );
    assert.equal(result.promotionalCode, "PROMOTIONAL_SPONSORED", contentType);
  }
  const ad = classifyEditorial(facets({ contentType: "advertising" }));
  assert.equal(ad.promotionalCode, "PROMOTIONAL_ADVERTISING");
  assert.equal(
    ad.promotionalReason,
    "Advertisement rather than reporting or research",
  );
});

test("marketing hype without meaningful technical evidence is rejected", () => {
  const cases = [
    [{ contentType: "marketing" }, "PROMOTIONAL_MARKETING"],
    [
      { contentType: "marketing", technicalSubstance: "limited" },
      "PROMOTIONAL_MARKETING",
    ],
    [{ unsupportedHype: true }, "PROMOTIONAL_HYPE"],
    [
      { contentType: "original-research", unsupportedHype: true },
      "PROMOTIONAL_HYPE",
    ],
    [{ technicalSubstance: "none" }, "PROMOTIONAL_LOW_SUBSTANCE"],
    [
      { technicalSubstance: "limited", vendorSelfReport: true },
      "PROMOTIONAL_LOW_SUBSTANCE",
    ],
    [
      {
        contentType: "product-announcement",
        technicalSubstance: "limited",
      },
      "PROMOTIONAL_LOW_SUBSTANCE",
    ],
  ];
  for (const [extra, code] of cases) {
    const result = classifyEditorial(facets(extra), { publisher: "P" });
    assert.equal(result.promotionalCode, code, JSON.stringify(extra));
    assert.equal(result.promotional, true);
  }
  // A vendor page with limited detail is low substance even when only the
  // source policy identifies it as the vendor's own publication.
  assert.equal(
    classifyEditorial(facets({ technicalSubstance: "limited" }), {
      sourceKind: "vendor",
    }).promotionalCode,
    "PROMOTIONAL_LOW_SUBSTANCE",
  );
  // Independent reporting with limited detail is not promotional.
  assert.equal(
    classifyEditorial(facets({ technicalSubstance: "limited" })).promotional,
    false,
  );
});

test("a technical product announcement with measurable findings is accepted as a self-report", () => {
  const result = classifyEditorial(
    facets({
      contentType: "product-announcement",
      vendorSelfReport: true,
      reportingOrganization: "Example DevTools",
    }),
    { publisher: "Example DevTools", sourceSite: "exampledevtools.com" },
  );
  assert.equal(result.promotional, false);
  assert.equal(result.attributedTo, "Example DevTools");
});

const credit = (reportingOrganization, context = QUANTUM) => {
  const result = classifyEditorial(
    facets({ vendorSelfReport: true, reportingOrganization }),
    context,
  );
  return [result.attributedTo, result.attributionBasis];
};

test("a competitor named in the article body is never credited", () => {
  // run-26e47111: the quantum article compares with "Google’s previous construction".
  assert.deepEqual(credit("Google"), ["Anthropic", "publisher"]);
  assert.deepEqual(credit("Google Quantum AI"), ["Anthropic", "publisher"]);
});

test("a company or product named in the headline is never credited", () => {
  // The quantum headline names Claude; other headlines name competitors.
  assert.deepEqual(credit("Claude"), ["Anthropic", "publisher"]);
  assert.deepEqual(
    credit("OpenAI", {
      publisher: "Example Labs",
      sourceSite: "examplelabs.com",
      sourceKind: "vendor-research",
    }),
    ["Example Labs", "publisher"],
  );
});

test("the organization is identified from the publisher name and the verified source domain", () => {
  assert.deepEqual(credit("Anthropic"), ["Anthropic", "publisher-name"]);
  assert.deepEqual(
    credit("GitHub", {
      publisher: "The GitHub Blog",
      sourceSite: "github.blog",
    }),
    ["GitHub", "publisher-name"],
  );
  assert.deepEqual(
    credit("Meta", { publisher: "Engineering at Meta", sourceSite: "fb.com" }),
    ["Meta", "publisher-name"],
  );
  assert.deepEqual(
    credit("Hugging Face", {
      publisher: "The HF Blog",
      sourceSite: "huggingface.co",
    }),
    ["Hugging Face", "source-domain"],
  );
  // Related, but neither the publisher nor the domain: the publisher is credited.
  assert.deepEqual(
    credit("Microsoft", {
      publisher: "The GitHub Blog",
      sourceSite: "github.blog",
    }),
    ["The GitHub Blog", "publisher"],
  );
});

test("ambiguous or unusable model-provided names fall back to the publisher", () => {
  for (const name of [
    "",
    "   ",
    "Blog",
    "The Engineering Team",
    "Anthrop",
    "Anthropic and Google",
    "anthropic.com",
    "Anthropic Research Team Quantum Group Of Scientists",
  ])
    assert.deepEqual(credit(name), ["Anthropic", "publisher"], name);
  // Generic words from the publisher's own name do not identify anyone.
  const github = { publisher: "The GitHub Blog", sourceSite: "github.blog" };
  for (const name of ["Blog", "The Blog"])
    assert.deepEqual(credit(name, github), ["The GitHub Blog", "publisher"]);
  // Only the source policy says it is the vendor's own site.
  const policyOnly = classifyEditorial(facets(), QUANTUM);
  assert.deepEqual(policyOnly.vendorSelfReportSignals, ["source-policy"]);
  assert.equal(policyOnly.attributedTo, "Anthropic");
  assert.equal(policyOnly.attributionBasis, "publisher");
  // Not a self-report: nothing to attribute.
  const independent = classifyEditorial(facets(), { publisher: "Example" });
  assert.equal(independent.vendorSelfReport, false);
  assert.equal(independent.attributedTo, null);
  assert.equal(independent.attributionBasis, null);
});

test("classification reasons are concise, recorded and deterministic", () => {
  const codes = EDITORIAL_POLICY.reject.map((r) => r.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const rule of EDITORIAL_POLICY.reject) {
    assert.match(rule.code, /^PROMOTIONAL_[A-Z_]+$/);
    assert.ok(rule.reason.length > 0 && rule.reason.length <= 80, rule.code);
  }
  const input = facets({
    contentType: "marketing",
    promotionalEvidence: `Sales copy. ${"x".repeat(400)}`,
  });
  const a = classifyEditorial(input, { publisher: "P" });
  const b = classifyEditorial(structuredClone(input), { publisher: "P" });
  assert.deepEqual(a, b);
  assert.equal(a.promotionalReason, "Primarily promotional marketing material");
  assert.equal(a.modelNote.length, 200);
  assert.ok(a.modelNote.startsWith("Sales copy."));
  // The model's note is kept only to explain a rejection.
  const accepted = classifyEditorial(
    facets({ promotionalEvidence: "Some note." }),
  );
  assert.equal(accepted.modelNote, "");
  // Every result is plain JSON for the report.
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});

test("missing or out-of-range facets fail safe", () => {
  assert.equal(
    classifyEditorial(undefined).promotionalCode,
    "PROMOTIONAL_LOW_SUBSTANCE",
  );
  const odd = classifyEditorial(
    facets({ contentType: "press-release", technicalSubstance: "high" }),
  );
  assert.equal(odd.contentType, "other");
  assert.equal(odd.technicalSubstance, "none");
  assert.equal(odd.promotionalCode, "PROMOTIONAL_LOW_SUBSTANCE");
  // Truthy non-boolean values never switch a flag on or off.
  const loose = classifyEditorial(
    facets({ sponsoredOrPaid: "no", vendorSelfReport: "yes" }),
  );
  assert.equal(loose.sponsoredOrPaid, false);
  assert.equal(loose.vendorSelfReport, false);
});

test("the extraction schema reports facets, not a single promotional flag", () => {
  const { properties } = SCHEMAS.extraction;
  assert.ok(!("isPromotional" in properties));
  assert.deepEqual(properties.editorial.required, [
    "contentType",
    "sponsoredOrPaid",
    "technicalSubstance",
    "unsupportedHype",
    "vendorSelfReport",
    "reportingOrganization",
    "promotionalEvidence",
  ]);
  assert.deepEqual(properties.editorial.properties.contentType.enum, [
    ...CONTENT_TYPES,
  ]);
});

// --- attribution -------------------------------------------------------------------------

const story = (en, fr, editorial) => ({
  en: { summary: en },
  fr: { summary: fr },
  evidence: { editorial },
});
const SELF = { vendorSelfReport: true, attributedTo: "Anthropic" };
const codes = (errors) => errors.map((e) => [e.code, e.path]);

test("a vendor self-report must be attributed in both English and French", () => {
  const ok = story(
    "Anthropic reports that Claude found smaller circuits.",
    "Selon Anthropic, Claude a trouvé des circuits plus petits.",
    SELF,
  );
  assert.deepEqual(checkAttribution(ok), []);
  for (const [en, fr] of [
    [
      "According to Anthropic, Claude found smaller circuits.",
      "D’après Anthropic, Claude a trouvé des circuits plus petits.",
    ],
    [
      "Claude found smaller circuits, Anthropic said.",
      "Claude a trouvé des circuits plus petits, indique Anthropic.",
    ],
    [
      "Researchers at Anthropic reported smaller circuits.",
      "Les chercheurs d’Anthropic affirment avoir trouvé des circuits plus petits.",
    ],
  ])
    assert.deepEqual(
      checkAttribution(story(en, fr, SELF)),
      [],
      `${en} / ${fr}`,
    );
});

test("English reporting verbs are accepted in singular and plural forms", () => {
  const fr = "Selon Anthropic, Claude a trouvé des circuits plus petits.";
  for (const en of [
    "Anthropic reports that Claude found smaller circuits.",
    "Anthropic researchers report that Claude found smaller circuits.",
    "Anthropic says Claude found smaller circuits.",
    "Anthropic engineers say Claude found smaller circuits.",
  ])
    assert.deepEqual(checkAttribution(story(en, fr, SELF)), [], en);
  const en = "Anthropic reports that Claude found smaller circuits.";
  for (const frText of [
    "Les chercheurs d’Anthropic indiquent que Claude a trouvé des circuits plus petits.",
    "Anthropic affirme que Claude a trouvé des circuits plus petits.",
  ])
    assert.deepEqual(checkAttribution(story(en, frText, SELF)), [], frText);
});

test("attribution to the wrong organization is rejected", () => {
  const errors = checkAttribution(
    story(
      "Google reports that Claude found smaller circuits.",
      "Selon Google, Claude a trouvé des circuits plus petits.",
      SELF,
    ),
  );
  assert.deepEqual(codes(errors), [
    ["ATTRIBUTION_MISSING", "story.en.summary"],
    ["ATTRIBUTION_MISSING", "story.fr.summary"],
  ]);
  assert.match(errors[0].message, /Attribute the findings to Anthropic/);
  assert.match(errors[0].message, /organization not named/);
});

test("missing attribution is reported per language with a machine-readable code", () => {
  const enOnly = story(
    "Anthropic reports that Claude found smaller circuits.",
    "Claude a trouvé des circuits plus petits.",
    SELF,
  );
  assert.deepEqual(codes(checkAttribution(enOnly, "stories[2]")), [
    ["ATTRIBUTION_MISSING", "stories[2].fr.summary"],
  ]);
  // Named without a reporting verb: the finding reads as established fact.
  const noVerb = story(
    "Anthropic's Claude found smaller circuits.",
    "Le modèle Claude d’Anthropic trouve des circuits plus petits.",
    SELF,
  );
  const errors = checkAttribution(noVerb);
  assert.deepEqual(codes(errors), [
    ["ATTRIBUTION_MISSING", "story.en.summary"],
    ["ATTRIBUTION_MISSING", "story.fr.summary"],
  ]);
  assert.match(errors[0].message, /no reporting verb/);
  // A reporting verb without the organization.
  const unnamed = story(
    "The company reports that Claude found smaller circuits.",
    "Selon l’entreprise, Claude a trouvé des circuits plus petits.",
    SELF,
  );
  assert.match(checkAttribution(unnamed)[0].message, /organization not named/);
  // Partial words do not count as naming the organization.
  assert.equal(
    checkAttribution(
      story(
        "Anthropics reports smaller circuits.",
        "Selon Anthropics, des circuits plus petits.",
        SELF,
      ),
    ).length,
    2,
  );
  // A self-report with no organization to name cannot pass.
  assert.deepEqual(
    codes(
      checkAttribution(
        story("Reports say so.", "Selon le rapport.", {
          vendorSelfReport: true,
          attributedTo: null,
        }),
      ),
    ),
    [["ATTRIBUTION_MISSING", "story.evidence.editorial.attributedTo"]],
  );
});

test("stories that are not vendor self-reports need no attribution", () => {
  assert.deepEqual(
    checkAttribution(
      story("Claude found circuits.", "Claude a trouvé des circuits.", {
        vendorSelfReport: false,
        attributedTo: null,
      }),
    ),
    [],
  );
  assert.deepEqual(checkAttribution({ en: {}, fr: {} }), []);
});

test("attribution markers and name matching handle accents and elisions in both languages", () => {
  assert.ok(
    ATTRIBUTION_MARKERS.en.length > 0 && ATTRIBUTION_MARKERS.fr.length > 0,
  );
  assert.ok(mentions("Les ingénieurs d’Anthropic", "Anthropic"));
  assert.ok(mentions("SELON ANTHROPIC", "anthropic"));
  assert.ok(mentions("a Google DeepMind team", "Google DeepMind"));
  assert.ok(!mentions("a Google team at DeepMind", "Google DeepMind"));
  assert.ok(!mentions("anything", ""));
});
