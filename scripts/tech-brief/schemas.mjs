// Strict JSON schemas for every model stage, plus a local validator.
//
// The schemas stay inside the documented Structured Outputs subset (root
// object, every property required, additionalProperties false, no
// minLength/maxLength/allOf). The API's strict mode is not trusted alone:
// every response is validated again locally, and length limits are enforced
// later by validate.mjs.

import { CONTENT_TYPES, TECHNICAL_SUBSTANCE } from "./editorial.mjs";
import { CATEGORIES } from "./validate.mjs";

const string = { type: "string" };
const isoDateOrUnknown = {
  type: "string",
  pattern: "^(\\d{4}-\\d{2}-\\d{2}|unknown)$",
};
const key = { type: "string", pattern: "^k\\d{1,3}$" };
const claimId = { type: "string", pattern: "^c[1-9]$" };
const category = { type: "string", enum: CATEGORIES };

const object = (properties) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const array = (items, maxItems) => ({ type: "array", items, maxItems });

const discoveryCandidate = object({
  url: string,
  headline: string,
  publisher: string,
  publishedDate: isoDateOrUnknown,
  category,
  practicalValue: string,
});

export const SCHEMAS = {
  discovery: object({ candidates: array(discoveryCandidate, 8) }),
  extraction: object({
    relevant: { type: "boolean" },
    mainSubjectMatchesHeadline: { type: "boolean" },
    // F5: facets only; the promotional decision is made by editorial.mjs.
    editorial: object({
      contentType: { type: "string", enum: CONTENT_TYPES },
      sponsoredOrPaid: { type: "boolean" },
      technicalSubstance: { type: "string", enum: TECHNICAL_SUBSTANCE },
      unsupportedHype: { type: "boolean" },
      vendorSelfReport: { type: "boolean" },
      reportingOrganization: string,
      promotionalEvidence: string,
    }),
    isOpinion: { type: "boolean" },
    category,
    practicalRelevance: { type: "integer", minimum: 1, maximum: 5 },
    claims: array(
      object({
        id: claimId,
        text: string,
        paragraphId: { type: "string", pattern: "^p\\d{1,3}$" },
        quote: string,
      }),
      5,
    ),
  }),
  verification: object({
    results: array(
      object({
        key,
        claimId,
        verdict: {
          type: "string",
          enum: ["entailed", "partial", "not_entailed"],
        },
        reason: string,
      }),
      60,
    ),
  }),
  writing: object({
    stories: array(
      object({
        key,
        en: object({
          headline: string,
          summary: string,
          whyItMatters: string,
          claimIds: array(claimId, 5),
        }),
        fr: object({ headline: string, summary: string, whyItMatters: string }),
      }),
      5,
    ),
  }),
  review: object({
    stories: array(
      object({
        key,
        faithful: { type: "boolean" },
        unsupportedSentences: array(string, 10),
        translationIssues: array(string, 10),
        copyrightConcern: { type: "boolean" },
      }),
      5,
    ),
  }),
  // One replacement core claim, restated strictly from a single quote.
  coreClaim: object({
    found: { type: "boolean" },
    claim: object({
      text: string,
      paragraphId: { type: "string", pattern: "^p\\d{1,3}$" },
      quote: string,
    }),
  }),
};
SCHEMAS.discoveryConversion = SCHEMAS.discovery;
SCHEMAS.repair = SCHEMAS.writing;
SCHEMAS.reverification = SCHEMAS.verification;

const ALLOWED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "description",
  "anyOf",
  "$defs",
  "$ref",
  "const",
]);

/** Problems that would make a schema unusable with strict Structured Outputs. */
export function structuredOutputProblems(schema) {
  const problems = [];
  if (schema?.type !== "object" || schema.anyOf)
    problems.push("root must be an object without anyOf");
  const visit = (node, path, depth) => {
    if (depth > 10) problems.push(`${path}: nesting deeper than 10`);
    for (const k of Object.keys(node))
      if (!ALLOWED_KEYWORDS.has(k))
        problems.push(`${path}: unsupported keyword ${k}`);
    if (node.type === "object") {
      if (node.additionalProperties !== false)
        problems.push(`${path}: additionalProperties must be false`);
      const props = Object.keys(node.properties ?? {});
      const required = node.required ?? [];
      if (
        props.length !== required.length ||
        props.some((p) => !required.includes(p))
      )
        problems.push(`${path}: every property must be required`);
      for (const p of props)
        visit(node.properties[p], `${path}.${p}`, depth + 1);
    }
    if (node.type === "array" && node.items)
      visit(node.items, `${path}[]`, depth + 1);
  };
  visit(schema, "$", 1);
  return problems;
}

/** Validates a value against the subset of JSON Schema used above. Returns error strings. */
export function validateAgainstSchema(value, schema, path = "$") {
  const errors = [];
  const typeOf = (v) =>
    Array.isArray(v)
      ? "array"
      : v === null
        ? "null"
        : Number.isInteger(v)
          ? "integer"
          : typeof v;
  const actual = typeOf(value);
  const expected = schema.type;
  const typeOk =
    expected === "number"
      ? actual === "number" || actual === "integer"
      : actual === expected;
  if (!typeOk) return [`${path}: expected ${expected}, got ${actual}`];
  if (schema.enum && !schema.enum.includes(value))
    errors.push(`${path}: not one of ${schema.enum.join(", ")}`);
  if (
    expected === "string" &&
    schema.pattern &&
    !new RegExp(schema.pattern).test(value)
  )
    errors.push(`${path}: does not match ${schema.pattern}`);
  if (
    (expected === "integer" || expected === "number") &&
    ((schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum))
  ) {
    errors.push(`${path}: out of range`);
  }
  if (expected === "array") {
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    value.forEach((item, i) =>
      errors.push(
        ...validateAgainstSchema(item, schema.items, `${path}[${i}]`),
      ),
    );
  }
  if (expected === "object") {
    for (const k of schema.required ?? [])
      if (!(k in value)) errors.push(`${path}.${k}: missing`);
    for (const k of Object.keys(value)) {
      if (!(k in (schema.properties ?? {}))) {
        if (schema.additionalProperties === false)
          errors.push(`${path}.${k}: not allowed`);
        continue;
      }
      errors.push(
        ...validateAgainstSchema(
          value[k],
          schema.properties[k],
          `${path}.${k}`,
        ),
      );
    }
  }
  return errors;
}
