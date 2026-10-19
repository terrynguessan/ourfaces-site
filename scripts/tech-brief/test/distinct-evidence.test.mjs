// A1: the "at least two supported claims" rule must count distinct evidence.
// Duplicated or superficially reworded claims count once; different facts
// count separately even when they come from the same paragraph.

import assert from "node:assert/strict";
import test from "node:test";
import { distinctClaims } from "../research.mjs";

// Sentences from test/fixtures/article-en.html.txt.
const P1 =
  "The headline feature is incremental mode, which stores the results of each run in a local cache and reuses them the next time you check the project.";
const P2_A =
  "the checker records a fingerprint for every source file and for the declarations it exports";
const P2_B =
  "only files whose fingerprint changed, together with the files that depend on them, are checked again";
const P3 =
  "In our benchmarks on three large monorepos, repeat checks after a small edit finished up to four times faster than in version 4.9.";

const claim = (id, text, quote, paragraphId = "p1", extra = {}) => ({
  id,
  text,
  quote,
  paragraphId,
  quoteFound: true,
  verdict: "entailed",
  ...extra,
});
const entailed = (cl) => cl.verdict === "entailed";
const ids = (result) => result.counted.map((c) => c.id);

test("identical supporting evidence reused for two claims counts once", () => {
  const result = distinctClaims(
    [
      claim(
        "c1",
        "Version 5.0 adds an incremental mode with a local cache.",
        P1,
      ),
      claim("c2", "The checker reuses cached results on the next check.", P1),
    ],
    entailed,
  );
  assert.deepEqual(ids(result), ["c1"]);
  assert.deepEqual(result.duplicates, [
    { id: "c2", of: "c1", reason: "same-evidence" },
  ]);
});

test("a quote contained in another claim's quote is the same evidence", () => {
  const result = distinctClaims(
    [
      claim(
        "c1",
        "Version 5.0 adds an incremental mode with a local cache.",
        P1,
      ),
      claim(
        "c2",
        "Results are stored in a local cache between runs.",
        "stores the results of each run in a local cache and reuses them",
      ),
    ],
    entailed,
  );
  assert.deepEqual(ids(result), ["c1"]);
  assert.equal(result.duplicates[0].reason, "same-evidence");
});

test("a superficially reworded duplicate claim counts once, even with another quote", () => {
  const result = distinctClaims(
    [
      claim(
        "c1",
        "Schema-constrained responses are now available on every API tier.",
        "schema-constrained responses are now available on every API tier",
        "p2",
      ),
      claim(
        "c2",
        "Schema-constrained responses are available on every API tier now.",
        "Structured outputs are now generally available for all API tiers",
        "p1",
      ),
    ],
    entailed,
  );
  assert.deepEqual(ids(result), ["c1"]);
  assert.deepEqual(result.duplicates, [
    { id: "c2", of: "c1", reason: "same-fact" },
  ]);
});

test("genuinely distinct facts from the same paragraph count separately", () => {
  const result = distinctClaims(
    [
      claim(
        "c1",
        "The checker records a fingerprint for every source file and its exports.",
        P2_A,
        "p2",
      ),
      claim(
        "c2",
        "Only changed files and their dependants are checked again.",
        P2_B,
        "p2",
      ),
    ],
    entailed,
  );
  assert.deepEqual(ids(result), ["c1", "c2"]);
  assert.deepEqual(result.duplicates, []);
});

test("distinct evidence across separate paragraphs counts separately", () => {
  const result = distinctClaims(
    [
      claim(
        "c1",
        "Version 5.0 adds an incremental mode with a local cache.",
        P1,
        "p1",
      ),
      claim(
        "c2",
        "Repeat checks were up to four times faster on three large monorepos.",
        P3,
        "p3",
      ),
      claim(
        "c3",
        "Only changed files and their dependants are checked again.",
        P2_B,
        "p2",
      ),
    ],
    entailed,
  );
  assert.deepEqual(ids(result), ["c1", "c2", "c3"]);
});

test("similar wording about different facts (different numbers) stays distinct", () => {
  const result = distinctClaims(
    [
      claim(
        "c1",
        "The P-192 seed came from lrand48 seeded with a Unix timestamp.",
        "the NIST P-192 seed was the output of lrand48",
        "p1",
      ),
      claim(
        "c2",
        "The P-224 seed came from lrand48 seeded with a Unix timestamp.",
        "the NIST P-224 seed was produced by the same generator",
        "p2",
      ),
    ],
    entailed,
  );
  assert.deepEqual(ids(result), ["c1", "c2"]);
});

test("overlapping but substantially different passages stay distinct", () => {
  const s1 = "Incremental mode is off by default in this release.";
  const s2 = "You can turn it on with the incremental flag.";
  const s3 =
    "The cache is written to a dedicated directory that should not be committed.";
  const result = distinctClaims(
    [
      claim(
        "c1",
        "Incremental mode must be enabled explicitly with a flag.",
        `${s1} ${s2}`,
        "p4",
      ),
      claim(
        "c2",
        "The cache directory should be excluded from version control.",
        `${s2} ${s3}`,
        "p4",
      ),
    ],
    entailed,
  );
  assert.deepEqual(ids(result), ["c1", "c2"]);
});

test("the main claim is kept and later duplicates are discounted, whatever the order", () => {
  const result = distinctClaims(
    [
      claim("c2", "The checker reuses cached results on the next check.", P1),
      claim(
        "c1",
        "Version 5.0 adds an incremental mode with a local cache.",
        P1,
      ),
    ],
    entailed,
  );
  assert.deepEqual(ids(result), ["c1"]);
  assert.deepEqual(result.duplicates, [
    { id: "c2", of: "c1", reason: "same-evidence" },
  ]);
});

test("missing or malformed evidence never counts", () => {
  const ok = claim(
    "c1",
    "Version 5.0 adds an incremental mode with a local cache.",
    P1,
  );
  const malformed = [
    claim("c2", "Repeat checks were up to four times faster.", P3, "p3", {
      quoteFound: false,
    }),
    claim("c3", "", P2_A, "p2"),
    claim("c4", "Faster checks.", P3, "p3"),
    claim("c5", "Only changed files are checked again.", undefined, "p2"),
    claim("c6", "Only changed files are checked again.", P2_B, "paragraph-2"),
    claim("c7", "Only changed files are checked again.", P2_B, "p2", {
      verdict: "partial",
    }),
    claim("c8", "Only changed files are checked again.", "", "p2"),
    {
      id: "c9",
      text: 42,
      quote: P2_B,
      paragraphId: "p2",
      quoteFound: true,
      verdict: "entailed",
    },
    null,
  ];
  const result = distinctClaims([ok, ...malformed], entailed);
  assert.deepEqual(ids(result), ["c1"]);
  const noCore = distinctClaims(
    [{ ...ok, quoteFound: false }, ...malformed],
    entailed,
  );
  assert.deepEqual(ids(noCore), []);
});
