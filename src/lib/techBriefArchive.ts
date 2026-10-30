import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TechBriefEdition } from "@/lib/techBrief";
import { parseEdition } from "@/lib/techBrief";

// The publication pipeline archives every edition here as YYYY-MM-DD.json,
// including the current one (scripts/tech-brief/publish.mjs).
const EDITIONS_DIR = join(process.cwd(), "src", "content", "tech-brief", "editions");
const EDITION_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

/** Editions older than `current`, newest first. The current edition is never
 *  included; with no current edition, every archived edition is previous. */
export function selectPreviousEditions(
  archived: TechBriefEdition[],
  current: TechBriefEdition | null,
) {
  return archived
    .filter((edition) => !current || edition.edition < current.edition)
    .sort((a, b) => (a.edition < b.edition ? 1 : a.edition > b.edition ? -1 : 0));
}

/** Every valid archived edition. Files that are unreadable, fail validation or
 *  do not match their file name are skipped rather than shown. Read at build
 *  time (the Insights pages are static), so a newly published edition appears
 *  with the next deployment; the ignore comments stop Turbopack tracing the
 *  whole project into the server output for these reads. */
export function getArchivedEditions(dir = EDITIONS_DIR) {
  let names: string[];
  try {
    names = readdirSync(/*turbopackIgnore: true*/ dir);
  } catch {
    return [];
  }

  const editions: TechBriefEdition[] = [];
  for (const name of names) {
    const match = EDITION_FILE.exec(name);
    if (!match) continue;
    let edition: TechBriefEdition | null = null;
    try {
      edition = parseEdition(JSON.parse(readFileSync(join(/*turbopackIgnore: true*/ dir, name), "utf8")));
    } catch {
      continue;
    }
    if (edition && edition.edition === match[1]) editions.push(edition);
  }
  return editions;
}

export function getPreviousEditions(current: TechBriefEdition | null) {
  return selectPreviousEditions(getArchivedEditions(), current);
}
