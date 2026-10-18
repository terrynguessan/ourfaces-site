// Calibration of the copyright-overlap check against realistic fixtures.
// The fixture file documents why each case should pass or fail; this test
// also compares the adopted rule with simpler alternatives so a future change
// to the thresholds shows its false-positive/false-negative trade-off.
//
// PROVISIONAL: these 17 cases are hand-written. Phase 3 must add cases built
// from actual AI-generated summaries and re-evaluate the thresholds before
// production use.

import assert from "node:assert/strict";
import test from "node:test";
import { COPYRIGHT, checkCopyright } from "../validate.mjs";
import { fixtureJson } from "./helpers.mjs";

const { sources, cases } = fixtureJson("copyright-cases.json");

for (const c of cases) {
  test(`${c.expect}: ${c.label}`, () => {
    const result = checkCopyright(c.text, sources[c.source]);
    assert.equal(result.ok ? "pass" : "fail", c.expect, JSON.stringify(result));
  });
}

test("adopted rule has no false positives or negatives on the fixtures; simpler rules do", () => {
  const evaluate = (thresholds) => {
    let falsePositives = 0;
    let falseNegatives = 0;
    for (const c of cases) {
      const ok = checkCopyright(c.text, sources[c.source], thresholds).ok;
      if (c.expect === "pass" && !ok) falsePositives++;
      if (c.expect === "fail" && ok) falseNegatives++;
    }
    return { falsePositives, falseNegatives };
  };
  assert.deepEqual(evaluate(COPYRIGHT), {
    falsePositives: 0,
    falseNegatives: 0,
  });
  // Plan v2's "any 8-word run" rule rejects legitimate factual phrases.
  assert.deepEqual(
    evaluate({ maxRun: 8, minRun: 8, maxRuns: 99, maxCoverage: 1 }),
    { falsePositives: 2, falseNegatives: 0 },
  );
  // A long-run-only rule misses patchwriting.
  assert.deepEqual(
    evaluate({ maxRun: 12, minRun: 8, maxRuns: 99, maxCoverage: 1 }),
    { falsePositives: 0, falseNegatives: 2 },
  );
});

test("proper names are exempt but reported", () => {
  const c = cases.find(
    (x) => x.label === "summary repeating a long official name",
  );
  const result = checkCopyright(c.text, sources[c.source]);
  assert.ok(result.ok);
  assert.ok(result.longest >= 12);
  assert.equal(result.exemptNames.length, 1);
});

test("a short summary that is mostly one copied run fails on coverage", () => {
  const source = sources.devtools;
  const result = checkCopyright(
    "Repeat checks after a small edit finished up to four times faster.",
    source,
  );
  assert.equal(result.ok, false);
  assert.ok(result.coverage > COPYRIGHT.maxCoverage);
});
