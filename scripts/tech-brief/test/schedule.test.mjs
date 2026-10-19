// Phase 4 scheduling: edition selection, stage windows, DST weekends, delayed
// and missed triggers, duplicate protection and the CLI. Expected instants are
// written out in UTC rather than derived from the helpers under test.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  RECOMMENDED_TRIGGERS,
  SCHEDULE,
  currentEdition,
  editionSchedule,
  isSaturdayDate,
  productionResearchBlock,
  stageDecision,
} from "../schedule.mjs";
import { addDays, zonedTimeToUtc } from "../validate.mjs";

const t = (iso) => new Date(iso);
const ms = (date, delta) => new Date(date.getTime() + delta);
const HOUR = 3600_000;
const iso = (plan) => ({
  researchOpens: plan.research.opens.toISOString(),
  researchUntil: plan.research.scheduledUntil.toISOString(),
  publicationOpens: plan.publication.opens.toISOString(),
  publicationUntil: plan.publication.scheduledUntil.toISOString(),
  recoveryUntil: plan.recoveryUntil.toISOString(),
});

test("isSaturdayDate accepts real Saturday dates only", () => {
  assert.equal(isSaturdayDate("2026-10-17"), true);
  assert.equal(isSaturdayDate("2026-10-18"), false);
  assert.equal(isSaturdayDate("2026-02-30"), false);
  assert.equal(isSaturdayDate("2026-10-17T00:00:00Z"), false);
  assert.equal(isSaturdayDate(null), false);
  assert.throws(() => editionSchedule("2026-10-18"), /not a Saturday/);
});

test("stage windows in daylight time, standard time and on both DST weekends", () => {
  // EDT (UTC-4) throughout.
  assert.deepEqual(iso(editionSchedule("2026-10-17")), {
    researchOpens: "2026-10-18T00:00:00.000Z",
    researchUntil: "2026-10-18T18:00:00.000Z",
    publicationOpens: "2026-10-19T00:00:00.000Z",
    publicationUntil: "2026-10-19T16:00:00.000Z",
    recoveryUntil: "2026-10-25T00:00:00.000Z",
  });
  // Fall back (Sunday 1 Nov 2026, 02:00 EDT -> 01:00 EST): Saturday is EDT,
  // Sunday afternoon onwards is EST.
  assert.deepEqual(iso(editionSchedule("2026-10-31")), {
    researchOpens: "2026-11-01T00:00:00.000Z",
    researchUntil: "2026-11-01T19:00:00.000Z",
    publicationOpens: "2026-11-02T01:00:00.000Z",
    publicationUntil: "2026-11-02T17:00:00.000Z",
    recoveryUntil: "2026-11-08T01:00:00.000Z",
  });
  // EST (UTC-5) throughout, across the new year.
  assert.deepEqual(iso(editionSchedule("2026-12-26")), {
    researchOpens: "2026-12-27T01:00:00.000Z",
    researchUntil: "2026-12-27T19:00:00.000Z",
    publicationOpens: "2026-12-28T01:00:00.000Z",
    publicationUntil: "2026-12-28T17:00:00.000Z",
    recoveryUntil: "2027-01-03T01:00:00.000Z",
  });
  // Spring forward (Sunday 14 Mar 2027, 02:00 EST -> 03:00 EDT).
  assert.deepEqual(iso(editionSchedule("2027-03-13")), {
    researchOpens: "2027-03-14T01:00:00.000Z",
    researchUntil: "2027-03-14T18:00:00.000Z",
    publicationOpens: "2027-03-15T00:00:00.000Z",
    publicationUntil: "2027-03-15T16:00:00.000Z",
    recoveryUntil: "2027-03-21T00:00:00.000Z",
  });
});

test("currentEdition is the latest Saturday whose 20:00 Eastern cutoff has passed", () => {
  for (const [now, expected] of [
    ["2026-10-17T23:59:59.999Z", "2026-10-10"], // Saturday 19:59:59.999 EDT
    ["2026-10-18T00:00:00.000Z", "2026-10-17"], // Saturday 20:00 EDT exactly
    ["2026-10-18T03:00:00.000Z", "2026-10-17"], // Saturday 23:00 EDT, Sunday in UTC
    ["2026-10-19T14:00:00.000Z", "2026-10-17"], // Monday
    ["2026-10-24T12:00:00.000Z", "2026-10-17"], // following Saturday morning
    ["2026-10-31T23:59:00.000Z", "2026-10-24"], // fall-back Saturday 19:59 EDT
    ["2026-11-01T00:00:00.000Z", "2026-10-31"], // fall-back Saturday 20:00 EDT
    ["2026-11-01T05:30:00.000Z", "2026-10-31"], // 01:30 EDT (first)
    ["2026-11-01T06:30:00.000Z", "2026-10-31"], // 01:30 EST (repeated hour)
    ["2027-01-01T15:00:00.000Z", "2026-12-26"], // new year's day
    ["2027-03-14T00:59:59.000Z", "2027-03-06"], // spring Saturday 19:59:59 EST
    ["2027-03-14T01:00:00.000Z", "2027-03-13"], // spring Saturday 20:00 EST
    ["2027-03-14T07:30:00.000Z", "2027-03-13"], // 03:30 EDT, after the skipped hour
  ])
    assert.equal(currentEdition(t(now)), expected, now);
});

// "m h * * dow" in America/New_York -> the trigger instant for an edition.
function triggerInstant(cron, edition) {
  const [minute, hour, , , dow] = cron.split(" ").map(Number);
  const offset = { 6: 0, 0: 1, 1: 2 }[dow];
  return zonedTimeToUtc(addDays(edition, offset), hour, minute);
}

test("every recommended trigger, even 2 hours late, lands inside its window for two years of editions", () => {
  for (const [stage, crons] of Object.entries(RECOMMENDED_TRIGGERS)) {
    for (const cron of crons) {
      const [minute, hour] = cron.split(" ").map(Number);
      assert.notEqual(minute, 0, `${cron}: avoid the top of the hour`);
      assert.ok(hour < 1 || hour > 3, `${cron}: avoid DST transition hours`);
    }
    for (let week = 0; week < 104; week++) {
      const edition = addDays("2026-10-03", 7 * week);
      for (const cron of crons)
        for (const delay of [0, 30 * 60_000, 2 * HOUR]) {
          const now = ms(triggerInstant(cron, edition), delay);
          const decision = stageDecision(stage, { now });
          assert.equal(
            decision.code,
            "DUE",
            `${stage} ${cron} ${edition} +${delay}`,
          );
          assert.equal(decision.edition, edition);
        }
    }
  }
});

test("research: boundaries, delayed triggers, missed schedules and manual recovery", () => {
  const plan = editionSchedule("2026-10-17");
  const opens = plan.research.opens;
  const decide = (now, extra = {}) =>
    stageDecision("research", { now, ...extra });

  // A trigger a moment before the cutoff never researches the coming edition.
  const early = decide(ms(opens, -1));
  assert.equal(early.due, false);
  assert.equal(early.edition, "2026-10-10");

  for (const delay of [0, 45 * 60_000, 3 * HOUR, 16 * HOUR, 18 * HOUR - 1]) {
    const d = decide(ms(opens, delay));
    assert.deepEqual([d.code, d.edition], ["DUE", "2026-10-17"], `+${delay}`);
  }
  // Every scheduled trigger missed: the scheduled window closes at Sunday 14:00.
  const missed = decide(plan.research.scheduledUntil);
  assert.equal(missed.code, "MISSED");
  assert.match(missed.reason, /manual recovery run is possible/);
  // A manual recovery run stays possible until the next edition's cutoff.
  assert.equal(
    decide(ms(plan.recoveryUntil, -1), { trigger: "manual" }).code,
    "DUE",
  );
  assert.equal(
    decide(plan.recoveryUntil, { trigger: "manual", edition: "2026-10-17" })
      .code,
    "STALE",
  );
  // Without an explicit edition, recovery targets the newest edition.
  const next = decide(plan.recoveryUntil, { trigger: "manual" });
  assert.deepEqual([next.code, next.edition], ["DUE", "2026-10-24"]);
  // A manual run for an edition whose week has not ended is early.
  const future = decide(t("2026-10-19T14:00:00Z"), {
    trigger: "manual",
    edition: "2026-10-24",
  });
  assert.equal(future.code, "EARLY");
  assert.equal(future.window.opens, "2026-10-25T00:00:00.000Z");
});

test("publication: not before Sunday 20:00 Eastern; scheduled until Monday 12:00; recovery until the next cutoff", () => {
  const plan = editionSchedule("2026-10-31"); // fall-back weekend
  const decide = (now, extra = {}) =>
    stageDecision("publication", { now, ...extra });
  // Sunday afternoon, after research but before publication opens.
  const early = decide(ms(plan.publication.opens, -1));
  assert.deepEqual([early.code, early.edition], ["EARLY", "2026-10-31"]);
  assert.equal(early.window.opens, "2026-11-02T01:00:00.000Z"); // 20:00 EST
  assert.equal(decide(plan.publication.opens).code, "DUE");
  assert.equal(decide(ms(plan.publication.scheduledUntil, -1)).code, "DUE");
  assert.equal(decide(plan.publication.scheduledUntil).code, "MISSED");
  assert.equal(
    decide(plan.publication.scheduledUntil, { trigger: "manual" }).code,
    "DUE",
  );
  assert.equal(
    decide(plan.recoveryUntil, { trigger: "manual", edition: "2026-10-31" })
      .code,
    "STALE",
  );
  // Spring forward: publication opens at 20:00 EDT = 00:00 UTC Monday.
  const spring = editionSchedule("2027-03-13");
  assert.equal(
    stageDecision("publication", { now: ms(spring.publication.opens, -1) })
      .code,
    "EARLY",
  );
  assert.equal(
    stageDecision("publication", { now: spring.publication.opens }).code,
    "DUE",
  );
});

test("duplicate protection: completed or already-published editions are never run again", () => {
  const now = t("2026-10-19T00:30:00Z"); // Sunday 20:30 EDT
  const d = (stage, extra) => stageDecision(stage, { now, ...extra }).code;
  assert.equal(d("publication", {}), "DUE");
  assert.equal(
    d("publication", { completedEdition: "2026-10-17" }),
    "ALREADY_DONE",
  );
  assert.equal(
    d("publication", { publishedEdition: "2026-10-17" }),
    "ALREADY_PUBLISHED",
  );
  assert.equal(
    d("research", { completedEdition: "2026-10-17" }),
    "ALREADY_DONE",
  );
  assert.equal(
    d("research", { publishedEdition: "2026-10-17" }),
    "ALREADY_PUBLISHED",
  );
  // An older published or completed edition does not block the new one.
  assert.equal(
    d("publication", {
      publishedEdition: "2026-10-10",
      completedEdition: "2026-10-10",
    }),
    "DUE",
  );
  // Never go backwards: recovering an edition older than the live one.
  assert.equal(
    stageDecision("publication", {
      now: t("2026-10-24T12:00:00Z"),
      trigger: "manual",
      edition: "2026-10-17",
      publishedEdition: "2026-10-24",
    }).code,
    "ALREADY_PUBLISHED",
  );
});

test("invalid inputs are rejected, never treated as due", () => {
  const now = t("2026-10-19T00:30:00Z");
  for (const [stage, options] of [
    ["deploy", { now }],
    ["research", { now, trigger: "cron" }],
    ["research", { now: new Date("not a date") }],
    ["research", { now, edition: "2026-10-17" }], // explicit edition on a schedule
    ["research", { now, trigger: "manual", edition: "2026-10-18" }],
    ["publication", { now, publishedEdition: "2026-10-19" }],
    ["publication", { now, completedEdition: "latest" }],
  ]) {
    const decision = stageDecision(stage, options);
    assert.equal(decision.code, "INVALID", JSON.stringify(options));
    assert.equal(decision.due, false);
  }
  assert.equal(SCHEDULE.timeZone, "America/New_York");
});

test("productionResearchBlock allows only the cutoff-to-recovery window", () => {
  const plan = editionSchedule("2026-10-17");
  assert.match(
    productionResearchBlock("2026-10-17", ms(plan.research.opens, -1)),
    /cannot start before its cutoff 2026-10-18T00:00:00.000Z/,
  );
  assert.equal(
    productionResearchBlock("2026-10-17", plan.research.opens),
    null,
  );
  assert.equal(
    productionResearchBlock("2026-10-17", ms(plan.recoveryUntil, -1)),
    null,
  );
  assert.match(
    productionResearchBlock("2026-10-17", plan.recoveryUntil),
    /is stale/,
  );
  assert.match(
    productionResearchBlock("2026-10-18", plan.research.opens),
    /must be a Saturday/,
  );
});

test("CLI prints the decision and exits 0 when due, 2 when not, 1 on invalid input", () => {
  const cli = fileURLToPath(new URL("../schedule.mjs", import.meta.url));
  const runCli = (args) => {
    try {
      return {
        status: 0,
        out: execFileSync(process.execPath, [cli, ...args], {
          encoding: "utf8",
        }),
      };
    } catch (error) {
      return { status: error.status, out: error.stdout };
    }
  };
  const due = runCli(["research", "--now", "2026-10-18T00:17:00Z"]);
  assert.equal(due.status, 0);
  assert.deepEqual(
    (({ due, edition, code }) => ({ due, edition, code }))(JSON.parse(due.out)),
    { due: true, edition: "2026-10-17", code: "DUE" },
  );
  const early = runCli(["publication", "--now", "2026-10-18T22:00:00Z"]);
  assert.equal(early.status, 2);
  assert.equal(JSON.parse(early.out).code, "EARLY");
  const manual = runCli([
    "publication",
    "--manual",
    "--edition",
    "2026-10-17",
    "--published-edition",
    "2026-10-10",
    "--now",
    "2026-10-20T12:00:00Z",
  ]);
  assert.equal(manual.status, 0);
  const invalid = runCli([
    "publication",
    "--edition",
    "2026-10-17",
    "--now",
    "2026-10-20T12:00:00Z",
  ]);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.out).code, "INVALID");
});
