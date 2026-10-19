// Phase 4: when the weekly research and publication stages are due.
//
// All times are America/New_York wall-clock times (DST-aware, via the date
// helpers in validate.mjs). An edition is identified by its Saturday date:
//
//   research     opens Saturday 20:00 (the edition cutoff, editionWindow);
//                scheduled runs may start until Sunday 14:00.
//   publication  opens Sunday 20:00; scheduled runs may start until
//                Monday 12:00.
//   recovery     a manually triggered run may start until the next edition's
//                cutoff (the following Saturday 20:00). After that the
//                edition is stale: the next one supersedes it.
//
// GitHub Actions schedules accept `timezone: "America/New_York"`, but they
// can be delayed or dropped under load and say nothing about repeated
// fall-back hours, so every trigger re-checks the window here. The
// recommended trigger times (RECOMMENDED_TRIGGERS) avoid the top of the hour
// and the 01:00-03:00 DST transition hours.

import { pathToFileURL } from "node:url";
import {
  TIME_ZONE,
  addDays,
  dateInZone,
  editionWindow,
  zonedTimeToUtc,
} from "./validate.mjs";

export const SCHEDULE = Object.freeze({
  timeZone: TIME_ZONE,
  // Research opens at the edition cutoff and manual recovery for either stage
  // ends at the next edition's cutoff; both come from editionWindow.
  research: Object.freeze({
    scheduledUntil: { dayOffset: 1, hour: 14, minute: 0 },
  }),
  publication: Object.freeze({
    opens: { dayOffset: 1, hour: 20, minute: 0 },
    scheduledUntil: { dayOffset: 2, hour: 12, minute: 0 },
  }),
});

// Cron expressions for `timezone: "America/New_York"` schedules: a primary
// trigger shortly after the window opens plus fallbacks for delayed or
// dropped runs. Every one falls inside its stage's scheduled window.
export const RECOMMENDED_TRIGGERS = Object.freeze({
  research: ["17 20 * * 6", "47 22 * * 6", "17 7 * * 0"],
  publication: ["7 20 * * 0", "37 22 * * 0", "7 7 * * 1"],
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real YYYY-MM-DD date that is a Saturday. */
export function isSaturdayDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    date.getUTCDay() === 6
  );
}

const at = (edition, { dayOffset, hour, minute }) =>
  zonedTimeToUtc(addDays(edition, dayOffset), hour, minute);

/** The UTC instants that bound each stage of an edition. */
export function editionSchedule(edition) {
  if (!isSaturdayDate(edition))
    throw new Error(`Edition ${edition} is not a Saturday date`);
  const researchOpens = editionWindow(edition).cutoff;
  return {
    edition,
    research: {
      opens: researchOpens,
      scheduledUntil: at(edition, SCHEDULE.research.scheduledUntil),
    },
    publication: {
      opens: at(edition, SCHEDULE.publication.opens),
      scheduledUntil: at(edition, SCHEDULE.publication.scheduledUntil),
    },
    recoveryUntil: editionWindow(addDays(edition, 7)).cutoff,
  };
}

/** The most recent Saturday whose 20:00 Eastern cutoff is at or before `now`. */
export function currentEdition(now) {
  const today = dateInZone(now);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  let saturday = addDays(today, -((weekday + 1) % 7));
  if (now < editionWindow(saturday).cutoff) saturday = addDays(saturday, -7);
  return saturday;
}

/**
 * Decides whether a stage ("research" or "publication") should run now.
 *
 * - trigger "schedule": the edition is derived from the clock and the run
 *   must start inside the stage's scheduled window.
 * - trigger "manual": an explicit edition may be given (default: the current
 *   one); the run must start between the stage's opening and the recovery
 *   deadline.
 * - publishedEdition: the edition currently live on the site, if any. An
 *   edition at or before it is never researched or published again.
 * - completedEdition: the latest edition this stage already completed (from
 *   the run records), so repeated triggers do nothing.
 *
 * Returns { due, stage, trigger, edition, code, reason, window }. Codes:
 * DUE, EARLY, MISSED (scheduled window passed; manual recovery possible),
 * STALE (recovery deadline passed), ALREADY_DONE, ALREADY_PUBLISHED, INVALID.
 */
export function stageDecision(
  stage,
  {
    now = new Date(),
    trigger = "schedule",
    edition = null,
    publishedEdition = null,
    completedEdition = null,
  } = {},
) {
  const result = (code, reason, extra = {}) => ({
    due: code === "DUE",
    stage,
    trigger,
    edition: extra.edition ?? edition,
    code,
    reason,
    window: extra.window ?? null,
  });
  if (!["research", "publication"].includes(stage))
    return result("INVALID", `Unknown stage ${stage}`);
  if (!["schedule", "manual"].includes(trigger))
    return result("INVALID", `Unknown trigger ${trigger}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime()))
    return result("INVALID", "The current time is not a valid date");
  if (trigger === "schedule" && edition !== null)
    return result(
      "INVALID",
      "Scheduled runs derive the edition from the clock; an explicit edition is for manual recovery only",
    );
  for (const [name, value] of [
    ["edition", edition],
    ["publishedEdition", publishedEdition],
    ["completedEdition", completedEdition],
  ])
    if (value !== null && !isSaturdayDate(value))
      return result("INVALID", `${name} ${value} is not a Saturday date`);

  const target = edition ?? currentEdition(now);
  const plan = editionSchedule(target);
  const opens = plan[stage].opens;
  const until =
    trigger === "schedule" ? plan[stage].scheduledUntil : plan.recoveryUntil;
  const window = { opens: opens.toISOString(), until: until.toISOString() };
  const done = (code, reason) =>
    result(code, reason, { edition: target, window });

  if (now < opens)
    return done(
      "EARLY",
      `${stage} for ${target} opens at ${window.opens} (${SCHEDULE.timeZone} 20:00)`,
    );
  if (now >= plan.recoveryUntil)
    return done(
      "STALE",
      `${target} was superseded by the next edition at ${plan.recoveryUntil.toISOString()}`,
    );
  if (publishedEdition !== null && target <= publishedEdition)
    return done(
      "ALREADY_PUBLISHED",
      `The site already shows edition ${publishedEdition}`,
    );
  if (completedEdition !== null && target <= completedEdition)
    return done(
      "ALREADY_DONE",
      `${stage} already completed for edition ${completedEdition}`,
    );
  if (now >= until)
    return done(
      "MISSED",
      `The scheduled ${stage} window for ${target} closed at ${window.until}; a manual recovery run is possible until ${plan.recoveryUntil.toISOString()}`,
    );
  return done("DUE", `${stage} for ${target} is due`);
}

/**
 * Production research guard used by research.mjs: a paid production run for
 * `edition` may only start between its Saturday 20:00 Eastern cutoff and the
 * recovery deadline. Returns null when allowed, otherwise a reason.
 */
export function productionResearchBlock(edition, now) {
  if (!isSaturdayDate(edition)) return "Edition date must be a Saturday";
  const plan = editionSchedule(edition);
  if (now < plan.research.opens)
    return `Production research for ${edition} cannot start before its cutoff ${plan.research.opens.toISOString()} (Saturday 20:00 ${SCHEDULE.timeZone})`;
  if (now >= plan.recoveryUntil)
    return `Edition ${edition} is stale: the next edition's cutoff passed at ${plan.recoveryUntil.toISOString()}`;
  return null;
}

// CLI ------------------------------------------------------------------------------------------
// node scripts/tech-brief/schedule.mjs <research|publication> [--manual]
//   [--edition YYYY-MM-DD] [--published-edition YYYY-MM-DD]
//   [--completed-edition YYYY-MM-DD] [--now ISO-8601]
// Prints the decision as JSON. Exit 0 when due, 2 when not due, 1 on invalid input.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? "") : null;
  };
  const nowArg = option("--now");
  const decision = stageDecision(args[0], {
    now: nowArg === null ? new Date() : new Date(nowArg),
    trigger: args.includes("--manual") ? "manual" : "schedule",
    edition: option("--edition"),
    publishedEdition: option("--published-edition"),
    completedEdition: option("--completed-edition"),
  });
  console.log(JSON.stringify(decision));
  process.exit(decision.due ? 0 : decision.code === "INVALID" ? 1 : 2);
}
