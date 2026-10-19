// Phase 4 spending ledger: reservations, settlement, month boundaries,
// corruption, concurrency (file lock, parallel processes, a temporary local
// Git remote) and the contract with research.mjs --month-spent. Offline only.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LedgerError,
  formatLedger,
  initLedger,
  ledgerSummary,
  monthSpentForReservation,
  parseLedger,
  readLedger,
  recordAdjustment,
  recordOpening,
  reserve,
  runMonths,
  settleFromReport,
  settleManually,
  usdToMicro,
} from "../ledger.mjs";
import { OpenAIError, createMeter } from "../openai.mjs";
import { loadConfig, runResearch } from "../research.mjs";
import { loadSourcePolicy } from "../validate.mjs";

const config = await loadConfig();
const CLI = fileURLToPath(new URL("../ledger.mjs", import.meta.url));
const T = (iso) => new Date(iso);
const LATER = T("2028-01-01T00:00:00.000Z"); // "now" for reads after every test record

const tempDir = () => mkdtempSync(join(tmpdir(), "tb-ledger-"));
function fresh({ initAt = "2026-09-20T00:00:00.000Z" } = {}) {
  const path = join(tempDir(), "tech-brief-ledger.jsonl");
  initLedger(path, { at: T(initAt) });
  return path;
}
const reserveAt = (path, id, edition, at, extra = {}) =>
  reserve(path, {
    id,
    edition,
    kind: "scheduled",
    at: T(at),
    config,
    ...extra,
  });
const stateOf = (path, now = LATER) => readLedger(path, { now }).state;
const monthUsd = (path, month) =>
  ledgerSummary(stateOf(path)).months.find((m) => m.month === month)
    ?.countedUsd ?? 0;
const text = (path) => readFileSync(path, "utf8");
const lineCount = (path) => text(path).split("\n").filter(Boolean).length;
const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  return "NO_ERROR";
};
// A research report as research.mjs writes it, with content that must never reach the ledger.
const reportFor = (edition, startedAt, counted, extra = {}) => ({
  runId: "run-0aabd72a",
  status: "edition",
  edition,
  startedAt,
  finishedAt: new Date(Date.parse(startedAt) + 4 * 60_000).toISOString(),
  budget: { runTotalCountedUsd: counted },
  candidates: [{ quote: "VERBATIM ARTICLE QUOTE", headline: "Story headline" }],
  apiKeyEcho: "FAKE-CREDENTIAL-should-never-be-copied",
  ...extra,
});

test("usdToMicro converts exactly and refuses imprecise or malformed amounts", () => {
  assert.equal(usdToMicro("0.75"), 750_000);
  assert.equal(usdToMicro("0.536"), 536_000);
  assert.equal(usdToMicro("-0.1"), -100_000);
  assert.equal(usdToMicro(0.191048), 191_048);
  assert.equal(usdToMicro(4), 4_000_000);
  for (const bad of [
    "1.2345678",
    "abc",
    "",
    "1e3",
    "0x10",
    "$1",
    " 1",
    NaN,
    Infinity,
    0.1234567,
    null,
  ])
    assert.equal(
      codeOf(() => usdToMicro(bad)),
      "INVALID_INPUT",
      String(bad),
    );
});

test("opening balances: required for a month the ledger did not see from its start, once per month", () => {
  // Initialised on 20 October: October spend before that is unknown.
  const path = fresh({ initAt: "2026-10-20T12:00:00.000Z" });
  assert.equal(
    codeOf(() =>
      reserveAt(path, "r1", "2026-10-24", "2026-10-25T00:17:00.000Z"),
    ),
    "MONTH_UNKNOWN",
  );
  recordOpening(path, {
    month: "2026-10",
    usd: "0.536",
    ref: "dry-runs-1-3",
    at: T("2026-10-21T00:00:00.000Z"),
  });
  const r1 = reserveAt(path, "r1", "2026-10-24", "2026-10-25T00:17:00.000Z");
  assert.equal(r1.monthSpentUsd, 0.536);
  assert.equal(monthUsd(path, "2026-10"), 1.286);
  assert.equal(
    codeOf(() =>
      recordOpening(path, {
        month: "2026-10",
        usd: "0.5",
        at: T("2026-10-26T00:00:00.000Z"),
      }),
    ),
    "DUPLICATE_OPENING",
  );
  assert.equal(
    codeOf(() =>
      recordOpening(path, {
        month: "2026-11",
        usd: "-0.1",
        at: T("2026-10-26T00:00:00.000Z"),
      }),
    ),
    "INVALID_INPUT",
  );
  // November began after initialisation everywhere on Earth: known, zero.
  const nov = reserveAt(path, "r2", "2026-11-07", "2026-11-08T01:17:00.000Z");
  assert.deepEqual(nov.months, ["2026-11"]);
  assert.equal(nov.monthSpentUsd, 0);
});

test("a reservation holds the full $0.75; settlement keeps the counted cost and releases the rest, idempotently", () => {
  const path = fresh();
  const r = reserveAt(
    path,
    "gh-100-1",
    "2026-10-17",
    "2026-10-18T00:17:00.000Z",
  );
  assert.equal(r.appended, true);
  assert.equal(r.record.amountMicroUsd, usdToMicro(config.budget.perRunUsd));
  assert.deepEqual(r.months, ["2026-10"]);
  assert.equal(monthUsd(path, "2026-10"), 0.75);

  const report = reportFor("2026-10-17", "2026-10-18T00:20:00.000Z", 0.191048);
  const settle = () =>
    settleFromReport(path, {
      id: "gh-100-1",
      report,
      at: T("2026-10-18T00:30:00.000Z"),
    });
  const first = settle();
  assert.equal(first.appended, true);
  assert.equal(monthUsd(path, "2026-10"), 0.191048);
  assert.deepEqual(ledgerSummary(stateOf(path)).unsettled, []);

  // Repeating the same settlement is a no-op; a different one is refused.
  const before = text(path);
  const again = settle();
  assert.deepEqual([again.appended, again.alreadySettled], [false, true]);
  assert.equal(text(path), before);
  assert.equal(
    codeOf(() =>
      settleFromReport(path, {
        id: "gh-100-1",
        report: { ...report, budget: { runTotalCountedUsd: 0.01 } },
        at: T("2026-10-18T00:40:00.000Z"),
      }),
    ),
    "SETTLEMENT_CONFLICT",
  );
  assert.equal(
    codeOf(() =>
      settleManually(path, {
        id: "gh-100-1",
        reason: "crash-unknown",
        at: T("2026-10-18T00:40:00.000Z"),
      }),
    ),
    "SETTLEMENT_CONFLICT",
  );
  assert.equal(text(path), before);
});

test("failed runs settle at their counted cost; crashed runs keep the full reservation until explicitly resolved", () => {
  const path = fresh();
  reserveAt(path, "failed-1", "2026-10-03", "2026-10-04T00:17:00.000Z");
  settleFromReport(path, {
    id: "failed-1",
    report: reportFor("2026-10-03", "2026-10-04T00:18:00.000Z", 0.012, {
      status: "error",
    }),
    at: T("2026-10-04T00:30:00.000Z"),
  });
  reserveAt(path, "crashed-1", "2026-10-10", "2026-10-11T00:17:00.000Z");
  assert.equal(monthUsd(path, "2026-10"), 0.762);

  // Months later the crashed reservation is still counted in full: no expiry.
  const later = ledgerSummary(stateOf(path, T("2027-06-01T00:00:00.000Z")));
  assert.deepEqual(
    later.unsettled.map((u) => [u.id, u.amountUsd]),
    [["crashed-1", 0.75]],
  );

  assert.equal(
    codeOf(() =>
      settleManually(path, {
        id: "crashed-1",
        reason: "crash-unknown",
        countedUsd: "0.1",
        at: T("2026-10-12T00:00:00.000Z"),
      }),
    ),
    "INVALID_INPUT",
  );
  settleManually(path, {
    id: "crashed-1",
    reason: "crash-unknown",
    at: T("2026-10-12T00:00:00.000Z"),
  });
  assert.equal(
    monthUsd(path, "2026-10"),
    0.762,
    "resolving a crash forgives nothing",
  );
  assert.deepEqual(ledgerSummary(stateOf(path)).unsettled, []);

  // A figure from the provider's usage page can replace the reservation.
  reserveAt(path, "crashed-2", "2026-10-17", "2026-10-18T00:17:00.000Z");
  assert.equal(
    codeOf(() =>
      settleManually(path, {
        id: "crashed-2",
        reason: "provider-reconciliation",
        at: T("2026-10-19T00:00:00.000Z"),
      }),
    ),
    "INVALID_INPUT",
  );
  settleManually(path, {
    id: "crashed-2",
    reason: "provider-reconciliation",
    countedUsd: "0.2",
    at: T("2026-10-19T00:00:00.000Z"),
  });
  assert.equal(monthUsd(path, "2026-10"), 0.962);
});

test("duplicate ids and overlapping reservations are refused; a recovery run must name the run it supersedes", () => {
  const path = fresh();
  reserveAt(path, "r1", "2026-10-17", "2026-10-18T00:17:00.000Z");
  const before = text(path);
  assert.equal(
    codeOf(() =>
      reserveAt(path, "r1", "2026-10-24", "2026-10-25T00:17:00.000Z"),
    ),
    "DUPLICATE_RESERVATION",
  );
  assert.equal(
    codeOf(() =>
      reserveAt(path, "r2", "2026-10-17", "2026-10-18T00:18:00.000Z"),
    ),
    "ACTIVE_RESERVATION",
  );
  assert.equal(
    codeOf(() =>
      reserveAt(path, "r2", "2026-10-17", "2026-10-18T00:18:00.000Z", {
        supersedes: "r9",
      }),
    ),
    "ACTIVE_RESERVATION",
  );
  assert.equal(
    codeOf(() =>
      reserveAt(path, "r2", "2026-10-24", "2026-10-25T00:17:00.000Z", {
        supersedes: "r1",
      }),
    ),
    "INVALID_INPUT",
  );
  assert.equal(text(path), before);

  // Manual recovery after r1 crashed: both stay counted until settled.
  const recovery = reserveAt(
    path,
    "r2",
    "2026-10-17",
    "2026-10-18T06:00:00.000Z",
    { kind: "manual", supersedes: "r1" },
  );
  assert.equal(recovery.monthSpentUsd, 0.75);
  assert.equal(monthUsd(path, "2026-10"), 1.5);
  assert.equal(
    codeOf(() => monthSpentForReservation(stateOf(path), "r1")),
    "NOT_ACTIVE",
  );
  assert.equal(monthSpentForReservation(stateOf(path), "r2"), 0.75);
  // The superseded run can still be settled if its report turns up.
  settleFromReport(path, {
    id: "r1",
    report: reportFor("2026-10-17", "2026-10-18T00:18:00.000Z", 0.05, {
      status: "error",
    }),
    at: T("2026-10-18T07:00:00.000Z"),
  });
  assert.equal(monthUsd(path, "2026-10"), 0.8);
  // A settled id is never reused.
  settleManually(path, {
    id: "r2",
    reason: "crash-unknown",
    at: T("2026-10-18T08:00:00.000Z"),
  });
  assert.equal(
    codeOf(() =>
      reserveAt(path, "r2", "2026-10-24", "2026-10-25T00:17:00.000Z"),
    ),
    "DUPLICATE_RESERVATION",
  );
  assert.equal(
    reserveAt(path, "r3", "2026-10-17", "2026-10-18T09:00:00.000Z", {
      kind: "manual",
    }).appended,
    true,
  );
});

test("budget exhaustion: a reservation may bring a month to exactly $4, never beyond", () => {
  const path = fresh();
  recordOpening(path, {
    month: "2026-10",
    usd: "3",
    at: T("2026-10-01T00:00:00.000Z"),
  });
  reserveAt(path, "r1", "2026-10-10", "2026-10-11T00:17:00.000Z");
  assert.equal(
    codeOf(() =>
      reserveAt(path, "r2", "2026-10-17", "2026-10-18T00:17:00.000Z"),
    ),
    "BUDGET_EXCEEDED",
  );
  settleFromReport(path, {
    id: "r1",
    report: reportFor("2026-10-10", "2026-10-11T00:18:00.000Z", 0.2),
    at: T("2026-10-11T00:30:00.000Z"),
  });
  assert.equal(
    reserveAt(path, "r2", "2026-10-17", "2026-10-18T00:17:00.000Z")
      .monthSpentUsd,
    3.2,
  );
  assert.equal(monthUsd(path, "2026-10"), 3.95);

  const exact = fresh();
  recordOpening(exact, {
    month: "2026-10",
    usd: "3.25",
    at: T("2026-10-01T00:00:00.000Z"),
  });
  assert.equal(
    reserveAt(exact, "r1", "2026-10-17", "2026-10-18T00:17:00.000Z").appended,
    true,
  );
  const over = fresh();
  recordOpening(over, {
    month: "2026-10",
    usd: "3.250001",
    at: T("2026-10-01T00:00:00.000Z"),
  });
  assert.equal(
    codeOf(() =>
      reserveAt(over, "r1", "2026-10-17", "2026-10-18T00:17:00.000Z"),
    ),
    "BUDGET_EXCEEDED",
  );
  // External spend (for example a manual run outside the workflow) counts too.
  recordAdjustment(over, {
    month: "2026-11",
    usd: "3.5",
    reason: "external-run",
    ref: "laptop-run",
    at: T("2026-10-02T00:00:00.000Z"),
  });
  assert.equal(
    codeOf(() =>
      reserveAt(over, "r2", "2026-11-07", "2026-11-08T01:17:00.000Z"),
    ),
    "BUDGET_EXCEEDED",
  );
  assert.equal(
    codeOf(() =>
      recordAdjustment(over, {
        month: "2026-11",
        usd: "-0.5",
        reason: "external-run",
        at: T("2026-10-02T00:00:00.000Z"),
      }),
    ),
    "INVALID_INPUT",
  );
  recordAdjustment(over, {
    month: "2026-11",
    usd: "-0.5",
    reason: "provider-reconciliation",
    at: T("2026-10-02T00:00:00.000Z"),
  });
  assert.equal(
    reserveAt(over, "r2", "2026-11-07", "2026-11-08T01:17:00.000Z")
      .monthSpentUsd,
    3,
  );
});

test("month boundaries: a run that may be billed in two months counts in both", () => {
  assert.deepEqual(runMonths("2026-10-18T00:17:00.000Z"), ["2026-10"]);
  assert.deepEqual(runMonths("2026-10-30T09:00:00.000Z"), ["2026-10"]);
  assert.deepEqual(runMonths("2026-10-31T09:00:00.000Z"), [
    "2026-10",
    "2026-11",
  ]);
  // Saturday 31 Oct 20:17 EDT is already 1 November in UTC.
  assert.deepEqual(runMonths("2026-11-01T00:17:00.000Z"), [
    "2026-10",
    "2026-11",
  ]);
  assert.deepEqual(runMonths("2026-12-31T23:30:00.000Z"), [
    "2026-12",
    "2027-01",
  ]);
  // A report that finished late extends the run's months.
  assert.deepEqual(runMonths("2026-10-31T03:00:00.000Z"), ["2026-10"]);
  assert.deepEqual(
    runMonths("2026-10-31T03:00:00.000Z", "2026-10-31T12:00:00.000Z"),
    ["2026-10", "2026-11"],
  );

  const path = fresh();
  recordOpening(path, {
    month: "2026-10",
    usd: "3.5",
    at: T("2026-10-01T00:00:00.000Z"),
  });
  // October is nearly spent: a run near the boundary is refused, a run well inside November is not.
  assert.equal(
    codeOf(() =>
      reserveAt(path, "r1", "2026-10-31", "2026-11-01T00:17:00.000Z"),
    ),
    "BUDGET_EXCEEDED",
  );
  const nov = reserveAt(path, "r2", "2026-11-07", "2026-11-08T01:17:00.000Z");
  assert.deepEqual([nov.months, nov.monthSpentUsd], [["2026-11"], 0]);

  const both = fresh();
  const r = reserveAt(both, "r1", "2026-10-31", "2026-11-01T00:17:00.000Z");
  assert.deepEqual(r.months, ["2026-10", "2026-11"]);
  assert.deepEqual(
    [monthUsd(both, "2026-10"), monthUsd(both, "2026-11")],
    [0.75, 0.75],
  );

  // Settled later than its window: the November share appears.
  const late = fresh();
  reserveAt(late, "r1", "2026-10-31", "2026-10-31T03:00:00.000Z");
  assert.equal(monthUsd(late, "2026-11"), 0);
  settleFromReport(late, {
    id: "r1",
    report: {
      ...reportFor("2026-10-31", "2026-10-31T03:05:00.000Z", 0.3),
      finishedAt: "2026-10-31T12:00:00.000Z",
    },
    at: T("2026-10-31T12:05:00.000Z"),
  });
  assert.deepEqual(
    [monthUsd(late, "2026-10"), monthUsd(late, "2026-11")],
    [0.3, 0.3],
  );

  // Initialised just before November began in UTC but after it began in UTC+14.
  const lateInit = fresh({ initAt: "2026-10-31T12:00:00.000Z" });
  assert.equal(
    codeOf(() =>
      reserveAt(lateInit, "r1", "2026-11-07", "2026-11-08T01:17:00.000Z"),
    ),
    "MONTH_UNKNOWN",
  );
});

test("an unsettled reservation from a previous month stays counted in its own month and keeps blocking its edition", () => {
  const path = fresh();
  reserveAt(path, "oct", "2026-10-17", "2026-10-18T00:17:00.000Z");
  const nov = reserveAt(path, "nov", "2026-11-07", "2026-11-08T01:17:00.000Z");
  assert.equal(
    nov.monthSpentUsd,
    0,
    "October's reservation is not charged to November",
  );
  const summary = ledgerSummary(stateOf(path));
  assert.deepEqual(
    summary.unsettled.map((u) => u.id),
    ["oct", "nov"],
  );
  assert.equal(monthUsd(path, "2026-10"), 0.75);
  assert.equal(
    codeOf(() =>
      reserveAt(path, "again", "2026-10-17", "2026-11-09T00:00:00.000Z"),
    ),
    "ACTIVE_RESERVATION",
  );
});

test("research preflight and the ledger agree: --month-spent excludes the run's own reservation", async () => {
  const policy = await loadSourcePolicy(
    new URL("../sources.json", import.meta.url),
  );
  // Runs research.mjs only as far as its preflight: the stub client is the
  // first thing called after the budget checks.
  const preflight = async (monthSpentUsd) => {
    let calls = 0;
    const result = await runResearch({
      edition: "2026-10-17",
      now: T("2026-10-18T00:30:00.000Z"),
      config,
      policy,
      client: {
        respond: async () => {
          calls++;
          throw new OpenAIError("AUTH", "offline stub");
        },
      },
      meter: createMeter({
        prices: config.prices,
        perRunUsd: config.budget.perRunUsd,
        retriesPerRun: 0,
      }),
      fetcher: null,
      mode: "dry-run",
      allowProvisionalPolicy: true,
      monthSpentUsd,
      nonce: "ledgertestnonce",
      runId: "run-00000000",
    });
    return { status: result.status, calls };
  };

  const path = fresh();
  recordOpening(path, {
    month: "2026-10",
    usd: "3.25",
    at: T("2026-10-01T00:00:00.000Z"),
  });
  const r = reserveAt(path, "r1", "2026-10-17", "2026-10-18T00:17:00.000Z");
  const monthSpent = monthSpentForReservation(stateOf(path), "r1");
  assert.equal(monthSpent, r.monthSpentUsd);
  assert.equal(monthSpent, 3.25);
  const passed = await preflight(monthSpent);
  assert.notEqual(passed.status, "budget-stop");
  assert.ok(passed.calls > 0, "the run got past its budget preflight");
  // Counting the run's own reservation again would wrongly stop it.
  const doubled = await preflight(monthSpent + config.budget.perRunUsd);
  assert.deepEqual([doubled.status, doubled.calls], ["budget-stop", 0]);

  // Where the ledger refuses, research.mjs refuses too.
  const over = fresh();
  recordOpening(over, {
    month: "2026-10",
    usd: "3.26",
    at: T("2026-10-01T00:00:00.000Z"),
  });
  assert.equal(
    codeOf(() =>
      reserveAt(over, "r1", "2026-10-17", "2026-10-18T00:17:00.000Z"),
    ),
    "BUDGET_EXCEEDED",
  );
  assert.deepEqual(await preflight(3.26), { status: "budget-stop", calls: 0 });
});

test("existing budget safeguards are unchanged and the reservation equals the per-run ceiling", () => {
  assert.equal(config.budget.perRunUsd, 0.75);
  assert.equal(config.budget.monthlyUsd, 4);
  assert.equal(config.budget.plannedProviderHardLimitUsd, 5);
  const meter = createMeter({
    prices: config.prices,
    perRunUsd: config.budget.perRunUsd,
    retriesPerRun: 2,
  });
  assert.throws(
    () => meter.ensureCanSpend("writing", 0.750001),
    (e) => e.kind === "BUDGET",
  );
  meter.ensureCanSpend("writing", 0.75);
  const path = fresh();
  assert.equal(
    reserveAt(path, "r1", "2026-10-17", "2026-10-18T00:17:00.000Z").record
      .amountMicroUsd,
    750_000,
  );
});

test("invalid identifiers, editions, reports and amounts are refused without changing the ledger", () => {
  const path = fresh();
  reserveAt(path, "r1", "2026-10-17", "2026-10-18T00:17:00.000Z");
  const before = text(path);
  for (const id of ["R1", "a", "a b", "../x", "-r1", "r".repeat(65), "", null])
    assert.equal(
      codeOf(() =>
        reserveAt(path, id, "2026-10-24", "2026-10-25T00:17:00.000Z"),
      ),
      "INVALID_INPUT",
      String(id),
    );
  for (const edition of ["2026-10-18", "2026-13-03", "latest", null])
    assert.equal(
      codeOf(() => reserveAt(path, "r2", edition, "2026-10-25T00:17:00.000Z")),
      "INVALID_INPUT",
      String(edition),
    );
  assert.equal(
    codeOf(() =>
      reserveAt(path, "r2", "2026-10-24", "2026-10-25T00:17:00.000Z", {
        kind: "auto",
      }),
    ),
    "INVALID_INPUT",
  );
  for (const [month, usd, reason, ref] of [
    ["2026-13", "1", "correction", null],
    ["2026-11", "11", "correction", null],
    ["2026-11", "1", "other", null],
    ["2026-11", "1", "correction", "a@b"],
    ["2026-11", "1", "correction", "has space"],
  ])
    assert.equal(
      codeOf(() =>
        recordAdjustment(path, {
          month,
          usd,
          reason,
          ref,
          at: T("2026-10-19T00:00:00.000Z"),
        }),
      ),
      "INVALID_INPUT",
      `${month} ${usd} ${reason} ${ref}`,
    );

  const report = reportFor("2026-10-17", "2026-10-18T00:20:00.000Z", 0.19);
  const settle = (r, id = "r1") =>
    codeOf(() =>
      settleFromReport(path, {
        id,
        report: r,
        at: T("2026-10-19T00:00:00.000Z"),
      }),
    );
  assert.equal(settle(report, "nope"), "NOT_FOUND");
  assert.equal(settle({ ...report, edition: "2026-10-24" }), "REPORT_MISMATCH");
  assert.equal(
    settle({ ...report, startedAt: "2026-10-17T22:00:00.000Z" }),
    "REPORT_MISMATCH",
  );
  assert.equal(
    settle({
      ...report,
      startedAt: "2026-10-18T07:00:00.000Z",
      finishedAt: "2026-10-18T07:05:00.000Z",
    }),
    "REPORT_MISMATCH",
  );
  assert.equal(settle({ ...report, status: "done" }), "REPORT_MISMATCH");
  assert.equal(settle({ ...report, runId: "run-XYZ" }), "REPORT_MISMATCH");
  assert.equal(settle({ ...report, budget: {} }), "REPORT_MISMATCH");
  assert.equal(
    settle({ ...report, budget: { runTotalCountedUsd: "0.19" } }),
    "REPORT_MISMATCH",
  );
  assert.equal(
    settle({ ...report, budget: { runTotalCountedUsd: -0.1 } }),
    "INVALID_INPUT",
  );
  assert.equal(
    settle({ ...report, budget: { runTotalCountedUsd: 11 } }),
    "INVALID_INPUT",
  );
  assert.equal(
    settle({ ...report, budget: { runTotalCountedUsd: NaN } }),
    "INVALID_INPUT",
  );
  assert.equal(settle(null), "REPORT_MISMATCH");
  assert.equal(text(path), before);
});

test("missing, incomplete or tampered ledgers fail closed and are never modified", () => {
  const dir = tempDir();
  assert.equal(
    codeOf(() => readLedger(join(dir, "none.jsonl"))),
    "LEDGER_MISSING",
  );
  assert.equal(
    codeOf(() =>
      reserveAt(
        join(dir, "none.jsonl"),
        "r1",
        "2026-10-17",
        "2026-10-18T00:17:00.000Z",
      ),
    ),
    "LEDGER_MISSING",
  );
  assert.equal(
    codeOf(() => parseLedger("")),
    "LEDGER_MISSING",
  );

  const path = fresh();
  recordOpening(path, {
    month: "2026-10",
    usd: "0.5",
    at: T("2026-10-01T00:00:00.000Z"),
  });
  reserveAt(path, "r1", "2026-10-17", "2026-10-18T00:17:00.000Z");
  settleFromReport(path, {
    id: "r1",
    report: reportFor("2026-10-17", "2026-10-18T00:20:00.000Z", 0.19),
    at: T("2026-10-18T00:30:00.000Z"),
  });
  const valid = text(path);
  const lines = valid.slice(0, -1).split("\n");
  const edit = (i, change) => {
    const copy = [...lines];
    copy[i] = JSON.stringify(change(JSON.parse(copy[i])));
    return `${copy.join("\n")}\n`;
  };
  const tampered = {
    "no final newline": valid.slice(0, -1),
    "partial last record": valid.slice(0, valid.length - 40),
    "edited earlier amount": edit(1, (r) => ({ ...r, amountMicroUsd: 1 })),
    "deleted record": `${[lines[0], lines[1], lines[3]].join("\n")}\n`,
    "reordered records": `${[lines[0], lines[1], lines[3], lines[2]].join("\n")}\n`,
    "extra field": edit(3, (r) => ({ ...r, note: "x" })),
    "non-canonical spacing": valid.replace('{"seq":2,', '{ "seq":2,'),
    "not JSON": `${lines.slice(0, 3).join("\n")}\nnot json\n`,
  };
  for (const [name, bad] of Object.entries(tampered)) {
    assert.equal(
      codeOf(() => parseLedger(bad, { now: LATER })),
      "LEDGER_CORRUPT",
      name,
    );
    writeFileSync(path, bad);
    assert.equal(
      codeOf(() =>
        reserveAt(path, "r2", "2026-10-24", "2026-10-25T00:17:00.000Z"),
      ),
      "LEDGER_CORRUPT",
      name,
    );
    assert.equal(text(path), bad, `${name}: the ledger was not modified`);
  }
  writeFileSync(path, valid);

  // The last record has no successor to protect it: an edit there keeps a
  // valid chain but changes the head hash, which the workflow compares with
  // the remote (verify --contains).
  const lastEdited = edit(3, (r) => ({ ...r, countedMicroUsd: 1 }));
  assert.notEqual(
    parseLedger(lastEdited, { now: LATER }).head,
    parseLedger(valid, { now: LATER }).head,
  );

  // Hash-valid ledgers that break the rules.
  const init = {
    type: "init",
    at: "2026-09-20T00:00:00.000Z",
    schema: "ourfaces-tech-brief-ledger/1",
  };
  const res = (id, edition, at, supersedes = null) => ({
    type: "reserve",
    at,
    id,
    edition,
    kind: "scheduled",
    amountMicroUsd: 750000,
    supersedes,
  });
  const open = (month, amount) => ({
    type: "opening",
    at: "2026-09-21T00:00:00.000Z",
    month,
    amountMicroUsd: amount,
    reason: "opening-balance",
    ref: null,
  });
  const set = (id) => ({
    type: "settle",
    at: "2026-10-19T00:00:00.000Z",
    id,
    source: "manual",
    status: "unknown",
    countedMicroUsd: 750000,
    reportRunId: null,
    finishedAt: null,
    reason: "crash-unknown",
  });
  const rules = {
    "no init": [open("2026-10", 1)],
    "second init": [init, init],
    "unknown schema": [{ ...init, schema: "other/1" }],
    "duplicate opening": [init, open("2026-10", 1), open("2026-10", 2)],
    "negative month": [
      init,
      {
        type: "adjust",
        at: "2026-09-21T00:00:00.000Z",
        month: "2026-10",
        amountMicroUsd: -1,
        reason: "correction",
        ref: null,
      },
    ],
    "duplicate reservation id": [
      init,
      res("r1", "2026-10-17", "2026-10-18T00:17:00.000Z"),
      res("r1", "2026-10-24", "2026-10-25T00:17:00.000Z"),
    ],
    "overlap without supersedes": [
      init,
      res("r1", "2026-10-17", "2026-10-18T00:17:00.000Z"),
      res("r2", "2026-10-17", "2026-10-18T01:00:00.000Z"),
    ],
    "settles unknown run": [init, set("r9")],
    "settled twice": [
      init,
      res("r1", "2026-10-17", "2026-10-18T00:17:00.000Z"),
      set("r1"),
      set("r1"),
    ],
    "fractional amount": [
      init,
      {
        ...res("r1", "2026-10-17", "2026-10-18T00:17:00.000Z"),
        amountMicroUsd: 0.5,
      },
    ],
    "invalid id": [init, res("R1", "2026-10-17", "2026-10-18T00:17:00.000Z")],
    "dated in the future": [
      init,
      res("r1", "2026-10-17", "2027-10-18T00:17:00.000Z"),
    ],
  };
  for (const [name, records] of Object.entries(rules))
    assert.equal(
      codeOf(() =>
        parseLedger(formatLedger(records), {
          now: T("2026-10-20T00:00:00.000Z"),
        }),
      ),
      "LEDGER_CORRUPT",
      name,
    );
  // The same records in a valid arrangement parse.
  assert.equal(
    parseLedger(
      formatLedger([
        init,
        res("r1", "2026-10-17", "2026-10-18T00:17:00.000Z"),
        set("r1"),
      ]),
      { now: LATER },
    ).records.length,
    3,
  );
});

test("the ledger is public-safe: fixed fields only, nothing copied from reports", () => {
  const path = fresh();
  recordOpening(path, {
    month: "2026-10",
    usd: "0.536",
    ref: "dry-runs-1-3",
    at: T("2026-10-01T00:00:00.000Z"),
  });
  reserveAt(path, "gh-123-1", "2026-10-17", "2026-10-18T00:17:00.000Z");
  settleFromReport(path, {
    id: "gh-123-1",
    report: reportFor("2026-10-17", "2026-10-18T00:20:00.000Z", 0.191048),
    at: T("2026-10-18T00:30:00.000Z"),
  });
  const content = text(path);
  for (const leak of [
    "VERBATIM",
    "headline",
    "FAKE-CREDENTIAL",
    "apiKey",
    "quote",
  ])
    assert.ok(!content.includes(leak), leak);
  const allowed = new Set([
    "seq",
    "type",
    "prev",
    "at",
    "schema",
    "month",
    "amountMicroUsd",
    "reason",
    "ref",
    "id",
    "edition",
    "kind",
    "supersedes",
    "source",
    "status",
    "countedMicroUsd",
    "reportRunId",
    "finishedAt",
  ]);
  for (const line of content.trim().split("\n"))
    for (const key of Object.keys(JSON.parse(line)))
      assert.ok(allowed.has(key), key);
});

test("Windows line endings in a checked-out ledger are read as the same records", () => {
  const path = fresh();
  reserveAt(path, "r1", "2026-10-17", "2026-10-18T00:17:00.000Z");
  const lf = text(path);
  const crlf = lf.replaceAll("\n", "\r\n");
  assert.equal(
    parseLedger(crlf, { now: LATER }).head,
    parseLedger(lf, { now: LATER }).head,
  );
  writeFileSync(path, crlf);
  reserveAt(path, "r2", "2026-10-24", "2026-10-25T00:17:00.000Z");
  assert.ok(!text(path).includes("\r"), "rewritten with LF");
  assert.equal(stateOf(path).records.length, 3);
});

test("one writer at a time: a held lock refuses updates; an interrupted write leaves the ledger intact", () => {
  const path = fresh();
  writeFileSync(`${path}.lock`, "");
  const before = text(path);
  assert.equal(
    codeOf(() =>
      reserveAt(path, "r1", "2026-10-17", "2026-10-18T00:17:00.000Z"),
    ),
    "LOCKED",
  );
  assert.equal(text(path), before);
  // A write that crashed before its rename leaves only a temporary file.
  writeFileSync(`${path}.tmp-999-deadbeef`, '{"seq":2,"type":"reserve"');
  assert.equal(
    codeOf(() =>
      reserveAt(path, "r1", "2026-10-17", "2026-10-18T00:17:00.000Z"),
    ),
    "LOCKED",
  );
  unlinkSync(`${path}.lock`);
  assert.equal(
    reserveAt(path, "r1", "2026-10-17", "2026-10-18T00:17:00.000Z").appended,
    true,
  );
  assert.equal(stateOf(path).records.length, 2);
  assert.ok(
    !existsSync(`${path}.lock`),
    "the lock is released after an update",
  );
});

test("parallel processes never lose or duplicate reservations and never exceed the budget", async () => {
  const path = fresh();
  const editions = [
    "2026-08-29",
    "2026-09-05",
    "2026-09-12",
    "2026-09-19",
    "2026-09-26",
    "2026-10-03",
    "2026-10-10",
    "2026-10-17",
  ];
  const runs = await Promise.all(
    editions.map(
      (edition, i) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [
            CLI,
            "reserve",
            "--ledger",
            path,
            "--id",
            `par-${i}`,
            "--edition",
            edition,
            "--kind",
            "scheduled",
            "--now",
            "2026-10-18T00:17:00.000Z",
          ]);
          let out = "";
          child.stdout.on("data", (d) => (out += d));
          child.on("close", (status) =>
            resolve({ status, result: JSON.parse(out) }),
          );
        }),
    ),
  );
  for (const { status, result } of runs)
    assert.ok(
      (status === 0 && result.ok) ||
        (status === 4 && result.code === "LOCKED") ||
        (status === 3 && result.code === "BUDGET_EXCEEDED"),
      JSON.stringify(result),
    );
  const ok = runs
    .filter((r) => r.status === 0)
    .map((r) => r.result.record.id)
    .sort();
  const state = stateOf(path);
  const reserved = state.records
    .filter((r) => r.type === "reserve")
    .map((r) => r.id)
    .sort();
  assert.deepEqual(
    reserved,
    ok,
    "every success is in the ledger; nothing else is",
  );
  assert.ok(reserved.length >= 1 && reserved.length <= 5);
  assert.ok(monthUsd(path, "2026-10") <= config.budget.monthlyUsd);
  assert.ok(!existsSync(`${path}.lock`));
});

function hasGit() {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

test(
  "Git branch storage: a stale writer's push is rejected, merging conflicts, and a retry after reset sees the other reservation",
  { skip: hasGit() ? false : "git not available" },
  () => {
    const root = tempDir();
    const emptyConfig = join(root, "empty.gitconfig");
    writeFileSync(emptyConfig, "");
    // Isolated from the user's Git configuration, hooks and signing setup.
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = (cwd, ...args) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Ledger Test",
          "-c",
          "user.email=ledger-test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.autocrlf=false",
          ...args,
        ],
        { cwd, env, encoding: "utf8", stdio: "pipe" },
      );
    const BRANCH = "tech-brief-ledger";
    const FILE = "tech-brief-ledger.jsonl";
    git(root, "init", "--bare", "remote.git");
    git(root, "clone", "remote.git", "a");
    const a = join(root, "a");
    git(a, "checkout", "-b", BRANCH);
    initLedger(join(a, FILE), { at: T("2026-09-20T00:00:00.000Z") });
    git(a, "add", FILE);
    git(a, "commit", "-m", "init ledger");
    git(a, "push", "origin", BRANCH);
    git(root, "clone", "--branch", BRANCH, "remote.git", "b");
    const b = join(root, "b");
    const commitAndPush = (cwd, message) => {
      git(cwd, "add", FILE);
      git(cwd, "commit", "-m", message);
      git(cwd, "push", "origin", BRANCH);
    };

    reserveAt(join(a, FILE), "a1", "2026-10-17", "2026-10-18T00:17:00.000Z");
    commitAndPush(a, "reserve a1");
    // B still has the old ledger, so its local reservation succeeds...
    reserveAt(join(b, FILE), "b1", "2026-10-17", "2026-10-18T00:18:00.000Z");
    git(b, "add", FILE);
    git(b, "commit", "-m", "reserve b1");
    // ...but its push is not a fast-forward and is rejected.
    assert.throws(
      () => git(b, "push", "origin", BRANCH),
      /rejected|fetch first|non-fast-forward/,
    );
    // Merging the two appends conflicts rather than silently keeping both.
    git(b, "fetch", "origin");
    assert.throws(
      () => git(b, "merge", `origin/${BRANCH}`),
      (error) => /CONFLICT/.test(`${error.stdout}${error.stderr}`),
    );
    git(b, "merge", "--abort");
    // The contract: reset to the remote and reserve again, which re-checks everything.
    git(b, "reset", "--hard", `origin/${BRANCH}`);
    assert.equal(
      codeOf(() =>
        reserveAt(
          join(b, FILE),
          "b1",
          "2026-10-17",
          "2026-10-18T00:19:00.000Z",
        ),
      ),
      "ACTIVE_RESERVATION",
    );
    reserveAt(join(b, FILE), "b2", "2026-10-24", "2026-10-25T00:17:00.000Z");
    commitAndPush(b, "reserve b2");

    git(a, "pull", "--ff-only", "origin", BRANCH);
    const state = stateOf(join(a, FILE));
    assert.deepEqual(
      state.records.map((r) => r.seq),
      [1, 2, 3],
    );
    assert.deepEqual(
      state.records.filter((r) => r.type === "reserve").map((r) => r.id),
      ["a1", "b2"],
    );
    const remote = git(
      root,
      "--git-dir",
      "remote.git",
      "show",
      `${BRANCH}:${FILE}`,
    );
    assert.equal(parseLedger(remote, { now: LATER }).head, state.head);
  },
);

test("CLI: init, opening, reserve, month-spent, settle, status and verify; refusals use distinct exit codes", () => {
  const dir = tempDir();
  const path = join(dir, "tech-brief-ledger.jsonl");
  const cli = (...args) => {
    try {
      return {
        status: 0,
        json: JSON.parse(
          execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" }),
        ),
      };
    } catch (error) {
      return { status: error.status, json: JSON.parse(error.stdout) };
    }
  };
  const at = (now) => ["--ledger", path, "--now", now];
  assert.equal(
    cli("status", ...at("2026-10-01T00:00:00.000Z")).json.code,
    "LEDGER_MISSING",
  );
  assert.equal(cli("init", ...at("2026-09-20T00:00:00.000Z")).status, 0);
  assert.equal(
    cli("init", ...at("2026-09-20T00:00:00.000Z")).json.code,
    "LEDGER_EXISTS",
  );
  assert.equal(
    cli(
      "opening",
      ...at("2026-10-01T00:00:00.000Z"),
      "--month",
      "2026-10",
      "--usd",
      "2.9",
    ).status,
    0,
  );
  const reserved = cli(
    "reserve",
    ...at("2026-10-18T00:17:00.000Z"),
    "--id",
    "gh-1-1",
    "--edition",
    "2026-10-17",
    "--kind",
    "scheduled",
  );
  assert.equal(reserved.status, 0);
  assert.equal(reserved.json.monthSpentUsd, 2.9);
  assert.equal(
    cli("month-spent", ...at("2026-10-18T00:18:00.000Z"), "--id", "gh-1-1").json
      .monthSpentUsd,
    2.9,
  );
  const verify = cli(
    "verify",
    ...at("2026-10-18T00:18:00.000Z"),
    "--contains",
    "gh-1-1",
  );
  assert.equal(verify.status, 0);
  assert.match(verify.json.recordHash, /^[0-9a-f]{64}$/);
  assert.equal(
    cli("verify", ...at("2026-10-18T00:18:00.000Z"), "--contains", "gh-9-9")
      .status,
    4,
  );
  // A second run in the same month would exceed $4: exit 3.
  const refused = cli(
    "reserve",
    ...at("2026-10-25T00:17:00.000Z"),
    "--id",
    "gh-2-1",
    "--edition",
    "2026-10-24",
    "--kind",
    "scheduled",
  );
  assert.deepEqual([refused.status, refused.json.code], [3, "BUDGET_EXCEEDED"]);
  const reportPath = join(dir, "report.json");
  writeFileSync(
    reportPath,
    JSON.stringify(
      reportFor("2026-10-17", "2026-10-18T00:20:00.000Z", 0.191048),
    ),
  );
  assert.equal(
    cli(
      "settle",
      ...at("2026-10-18T00:30:00.000Z"),
      "--id",
      "gh-1-1",
      "--report",
      reportPath,
    ).status,
    0,
  );
  assert.equal(
    cli(
      "settle",
      ...at("2026-10-18T00:31:00.000Z"),
      "--id",
      "gh-1-1",
      "--report",
      reportPath,
    ).json.alreadySettled,
    true,
  );
  assert.equal(
    cli("month-spent", ...at("2026-10-18T00:32:00.000Z"), "--id", "gh-1-1").json
      .code,
    "NOT_ACTIVE",
  );
  const status = cli("status", ...at("2026-10-18T00:32:00.000Z")).json;
  assert.deepEqual(status.months, [
    { month: "2026-10", known: true, countedUsd: 3.091048 },
  ]);
  // Now there is room again.
  assert.equal(
    cli(
      "reserve",
      ...at("2026-10-25T00:17:00.000Z"),
      "--id",
      "gh-2-1",
      "--edition",
      "2026-10-24",
      "--kind",
      "scheduled",
    ).status,
    0,
  );
  // Corrupt ledger: exit 4, nothing written. Missing --ledger: exit 1.
  writeFileSync(path, `${text(path)}garbage\n`);
  assert.deepEqual(
    (({ status, json }) => [status, json.code])(
      cli(
        "reserve",
        ...at("2026-11-08T01:17:00.000Z"),
        "--id",
        "gh-3-1",
        "--edition",
        "2026-11-07",
        "--kind",
        "scheduled",
      ),
    ),
    [4, "LEDGER_CORRUPT"],
  );
  assert.equal(cli("status").status, 1);
});
