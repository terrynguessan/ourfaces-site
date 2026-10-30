// The Insights page's Previous Editions archive (src/lib/techBriefArchive.ts):
// which archived editions are listed, in what order, and which files are
// skipped. Synthetic editions only; the committed content is read, never
// written. The site files are loaded through Node's TypeScript type stripping
// from temporary copies with their "@/" imports replaced, as in
// phase1-compat.test.mjs.

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { fixtureJson } from "./helpers.mjs";

const SITE_LIB = fileURLToPath(new URL("../../../src/lib/", import.meta.url));
const CONTENT = fileURLToPath(
  new URL("../../../src/content/tech-brief/", import.meta.url),
);

const siteSource = readFileSync(join(SITE_LIB, "techBrief.ts"), "utf8")
  .replace(
    'import latestEdition from "@/content/tech-brief/latest.json";',
    "const latestEdition = null;",
  )
  .replace(
    'import type { Locale } from "@/lib/i18n";',
    'type Locale = "en" | "fr";',
  );
const archiveSource = readFileSync(
  join(SITE_LIB, "techBriefArchive.ts"),
  "utf8",
).replaceAll('from "@/lib/techBrief";', 'from "./techBrief.ts";');
for (const source of [siteSource, archiveSource]) {
  assert.ok(
    !source.includes('from "@/'),
    "a site file gained an import this test does not stub",
  );
}
const libDir = mkdtempSync(join(tmpdir(), "tech-brief-archive-"));
writeFileSync(join(libDir, "techBrief.ts"), siteSource);
writeFileSync(join(libDir, "techBriefArchive.ts"), archiveSource);
const archive = await import(
  pathToFileURL(join(libDir, "techBriefArchive.ts")).href
);
rmSync(libDir, { recursive: true, force: true });

const edition = (date, publishedOn = date) => ({
  ...fixtureJson("valid-edition.json"),
  edition: date,
  publishedOn,
});
const ids = (editions) => editions.map((e) => e.edition);

function withEditionsDir(files, run) {
  const dir = mkdtempSync(join(tmpdir(), "tech-brief-editions-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(
        join(dir, name),
        typeof content === "string" ? content : JSON.stringify(content),
      );
    }
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("previous editions exclude the current edition and list older ones newest first", () => {
  const editions = withEditionsDir(
    {
      "2026-10-10.json": edition("2026-10-10", "2026-10-11"),
      "2026-10-24.json": edition("2026-10-24", "2026-10-25"),
      "2026-10-17.json": edition("2026-10-17", "2026-10-18"),
    },
    (dir) => archive.getArchivedEditions(dir),
  );
  const current = editions.find((e) => e.edition === "2026-10-24");
  const previous = archive.selectPreviousEditions(editions, current);
  assert.deepEqual(ids(previous), ["2026-10-17", "2026-10-10"]);
  assert.deepEqual(
    previous.map((e) => e.publishedOn),
    ["2026-10-18", "2026-10-11"],
  );
});

test("with only the current edition archived, there are no previous editions", () => {
  const current = edition("2026-10-24", "2026-10-25");
  assert.deepEqual(archive.selectPreviousEditions([current], current), []);
  assert.deepEqual(archive.selectPreviousEditions([], current), []);
});

test("when a newer edition is published, the former latest moves into the archive", () => {
  const older = edition("2026-10-24", "2026-10-25");
  const newer = edition("2026-10-31", "2026-11-01");
  assert.deepEqual(archive.selectPreviousEditions([older], older), []);
  assert.deepEqual(ids(archive.selectPreviousEditions([newer, older], newer)), [
    "2026-10-24",
  ]);
});

test("editions newer than the current one are never listed as previous", () => {
  const current = edition("2026-10-24");
  const editions = [edition("2026-10-31"), current, edition("2026-10-17")];
  assert.deepEqual(ids(archive.selectPreviousEditions(editions, current)), [
    "2026-10-17",
  ]);
});

test("without a current edition, every archived edition is previous, newest first", () => {
  const editions = [edition("2026-10-17"), edition("2026-10-24")];
  assert.deepEqual(ids(archive.selectPreviousEditions(editions, null)), [
    "2026-10-24",
    "2026-10-17",
  ]);
});

test("unreadable, invalid, misnamed and unrelated files are skipped", () => {
  const invalid = edition("2026-10-03");
  invalid.stories = invalid.stories.slice(0, 2);
  const editions = withEditionsDir(
    {
      "2026-10-17.json": edition("2026-10-17"),
      "2026-10-10.json": "{ not json",
      "2026-10-03.json": invalid,
      "2026-09-26.json": edition("2026-09-19"),
      "latest.json": edition("2026-09-12"),
      "2026-09-05.json.bak": edition("2026-09-05"),
    },
    (dir) => archive.getArchivedEditions(dir),
  );
  assert.deepEqual(ids(editions), ["2026-10-17"]);
});

test("a missing editions directory yields an empty archive", () => {
  const dir = mkdtempSync(join(tmpdir(), "tech-brief-editions-"));
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(archive.getArchivedEditions(dir), []);
  mkdirSync(dir);
  try {
    assert.deepEqual(archive.getArchivedEditions(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed archive never lists the committed latest edition as previous", () => {
  const editions = archive.getArchivedEditions(join(CONTENT, "editions"));
  const latest = JSON.parse(readFileSync(join(CONTENT, "latest.json"), "utf8"));
  const current = editions.find((e) => e.edition === latest.edition) ?? null;
  const previous = archive.selectPreviousEditions(editions, current);
  assert.ok(!ids(previous).includes(latest.edition));
  assert.deepEqual(ids(previous), [...ids(previous)].sort().reverse());
});
