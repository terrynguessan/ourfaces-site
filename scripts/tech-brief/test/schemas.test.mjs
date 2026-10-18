import assert from "node:assert/strict";
import test from "node:test";
import {
  SCHEMAS,
  structuredOutputProblems,
  validateAgainstSchema,
} from "../schemas.mjs";
import { CATEGORIES } from "../validate.mjs";

for (const [name, schema] of Object.entries(SCHEMAS)) {
  test(`${name} schema stays inside the documented Structured Outputs subset`, () => {
    assert.deepEqual(structuredOutputProblems(schema), []);
    assert.ok(!JSON.stringify(schema).includes("minLength"));
    assert.ok(!JSON.stringify(schema).includes("maxLength"));
  });
}

test("structuredOutputProblems catches unsupported shapes", () => {
  const bad = {
    type: "object",
    properties: {
      a: { type: "string", minLength: 1 },
      b: { type: "object", properties: {} },
    },
    required: ["a"],
  };
  const problems = structuredOutputProblems(bad);
  assert.ok(problems.some((p) => p.includes("additionalProperties")));
  assert.ok(problems.some((p) => p.includes("minLength")));
  assert.ok(
    problems.some((p) => p.includes("every property must be required")),
  );
});

test("category enums match the site's categories", () => {
  assert.deepEqual(
    SCHEMAS.discovery.properties.candidates.items.properties.category.enum,
    CATEGORIES,
  );
  assert.deepEqual(SCHEMAS.extraction.properties.category.enum, CATEGORIES);
});

test("validateAgainstSchema enforces types, enums, patterns, ranges, required and extra keys", () => {
  const extraction = {
    relevant: true,
    mainSubjectMatchesHeadline: true,
    isPromotional: false,
    isOpinion: false,
    category: "applied-ai",
    practicalRelevance: 4,
    claims: [{ id: "c1", text: "t", paragraphId: "p2", quote: "q" }],
  };
  assert.deepEqual(validateAgainstSchema(extraction, SCHEMAS.extraction), []);
  const broken = structuredClone(extraction);
  broken.category = "crypto";
  broken.practicalRelevance = 9;
  broken.claims[0].id = "claim-1";
  broken.claims[0].paragraphId = "2";
  broken.extra = 1;
  delete broken.isOpinion;
  const errors = validateAgainstSchema(broken, SCHEMAS.extraction);
  for (const fragment of [
    "category: not one of",
    "practicalRelevance: out of range",
    "id: does not match",
    "paragraphId: does not match",
    "extra: not allowed",
    "isOpinion: missing",
  ]) {
    assert.ok(
      errors.some((e) => e.includes(fragment)),
      fragment,
    );
  }
  assert.ok(
    validateAgainstSchema(
      { candidates: new Array(9).fill({}) },
      SCHEMAS.discovery,
    ).some((e) => e.includes("more than 8 items")),
  );
  assert.deepEqual(validateAgainstSchema([], SCHEMAS.review), [
    "$: expected object, got array",
  ]);
});
