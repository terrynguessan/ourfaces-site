// Guards against drift between the pipeline validator (checkSchema) and the
// website's own validator (src/lib/techBrief.ts parseEdition): anything the
// pipeline accepts must render, and anything the site rejects must be rejected
// by the pipeline. The site file is loaded through Node's TypeScript type
// stripping from a temporary copy (its "@/" JSON import is replaced).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { checkSchema } from "../validate.mjs";
import { fixtureJson } from "./helpers.mjs";

const SITE_FILE = fileURLToPath(
  new URL("../../../src/lib/techBrief.ts", import.meta.url),
);
const LATEST = fileURLToPath(
  new URL("../../../src/content/tech-brief/latest.json", import.meta.url),
);

const source = readFileSync(SITE_FILE, "utf8")
  .replace(
    'import latestEdition from "@/content/tech-brief/latest.json";',
    "const latestEdition = null;",
  )
  .replace(
    'import type { Locale } from "@/lib/i18n";',
    'type Locale = "en" | "fr";',
  );
assert.ok(
  !source.includes('from "@/'),
  "techBrief.ts gained an import this test does not stub",
);
const dir = mkdtempSync(join(tmpdir(), "tech-brief-site-"));
writeFileSync(join(dir, "techBrief.ts"), source);
const site = await import(pathToFileURL(join(dir, "techBrief.ts")).href);
rmSync(dir, { recursive: true, force: true });

const valid = () => fixtureJson("valid-edition.json");
const ch = (code) => String.fromCharCode(code);

test("the committed latest.json is the empty edition and both validators reject it", () => {
  const latest = JSON.parse(readFileSync(LATEST, "utf8"));
  assert.deepEqual(latest, {
    schemaVersion: 1,
    edition: null,
    publishedOn: null,
    stories: [],
  });
  assert.equal(site.parseEdition(latest), null);
  assert.ok(checkSchema(latest).length > 0);
});

test("a pipeline-valid edition renders on the site unchanged", () => {
  const edition = valid();
  assert.deepEqual(checkSchema(edition), []);
  const parsed = site.parseEdition(edition);
  assert.ok(parsed);
  assert.equal(parsed.stories.length, edition.stories.length);
  for (const [i, story] of edition.stories.entries()) {
    for (const key of [
      "id",
      "category",
      "url",
      "publisher",
      "sourcePublishedOn",
      "sourceHeadline",
      "sourceHeadlineLang",
    ]) {
      assert.equal(parsed.stories[i][key], story[key]);
    }
    assert.deepEqual(parsed.stories[i].en, story.en);
    assert.deepEqual(parsed.stories[i].fr, story.fr);
  }
});

const mutations = {
  "schemaVersion 2": (d) => (d.schemaVersion = 2),
  "javascript URL": (d) => (d.stories[0].url = "javascript:alert(1)"),
  "http URL": (d) => (d.stories[0].url = "http://example.com/"),
  credentials: (d) => (d.stories[0].url = "https://a:b@example.com/"),
  "URL over 2048": (d) =>
    (d.stories[0].url = `https://example.com/${"a".repeat(2050)}`),
  "2 stories": (d) => d.stories.splice(2),
  "6 stories": (d) =>
    d.stories.push(
      { ...d.stories[0], id: "x5" },
      { ...d.stories[1], id: "x6" },
    ),
  "duplicate id": (d) => (d.stories[1].id = d.stories[0].id),
  "id with spaces": (d) => (d.stories[0].id = "a b"),
  "unknown category": (d) => (d.stories[0].category = "other"),
  "missing fr": (d) => delete d.stories[0].fr,
  "empty en headline": (d) => (d.stories[0].en.headline = ""),
  "headline 201 chars": (d) => (d.stories[0].fr.headline = "a".repeat(201)),
  "summary 701 chars": (d) => (d.stories[0].en.summary = "a".repeat(701)),
  "why 501 chars": (d) => (d.stories[0].en.whyItMatters = "a".repeat(501)),
  "publisher 101 chars": (d) => (d.stories[0].publisher = "a".repeat(101)),
  "leading space": (d) =>
    (d.stories[0].publisher = ` ${d.stories[0].publisher}`),
  "bidi override": (d) => (d.stories[0].fr.summary += ch(0x202e)),
  "C1 control": (d) => (d.stories[0].en.summary += ch(0x85)),
  "impossible date": (d) => (d.publishedOn = "2026-02-29"),
  "bad lang tag": (d) => (d.stories[0].sourceHeadlineLang = "EN"),
  "stories not array": (d) => (d.stories = {}),
  "boundary: headline exactly 200": (d) =>
    (d.stories[0].en.headline = "a".repeat(200)),
  "boundary: 5 stories": (d) => d.stories.push({ ...d.stories[0], id: "x5" }),
};

for (const [name, mutate] of Object.entries(mutations)) {
  test(`pipeline and site agree: ${name}`, () => {
    const edition = valid();
    mutate(edition);
    const pipelineOk = checkSchema(edition).length === 0;
    const siteOk = site.parseEdition(edition) !== null;
    assert.equal(
      pipelineOk,
      siteOk,
      `pipeline ${pipelineOk ? "accepts" : "rejects"}, site ${siteOk ? "accepts" : "rejects"}`,
    );
    if (!name.startsWith("boundary")) assert.equal(pipelineOk, false);
  });
}
