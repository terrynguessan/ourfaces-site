// Phase 4: append-only spending ledger for paid Tech Brief research runs.
//
// The ledger is a JSON Lines file (one record per line, canonical key order,
// final newline). Records are chained: each one holds the SHA-256 of the
// previous line, so an edited, removed, reordered or truncated record makes
// the whole ledger invalid, and every operation then fails closed. Amounts
// are whole micro-dollars. Records hold only dates, editions, identifiers,
// amounts and fixed reason codes: no credentials, article text or free text,
// so the file is safe in a public repository.
//
// Accounting (software estimates, not billing guarantees):
// - A run reserves the full per-run ceiling (config budget.perRunUsd) before
//   any paid call, and the reservation counts in full until it is settled.
// - Settlement replaces the reservation with the run's counted cost from its
//   research report (budget.runTotalCountedUsd), releasing only the unused
//   part. A crashed run is never forgiven: it stays at the full reservation,
//   or is settled manually at the full amount or at a reconciled figure.
// - Billing month: OpenAI's billing month and its time zone are not verified.
//   Every instant is treated as belonging to any calendar date it has from
//   UTC-12 to UTC+14, so a run near a month boundary counts in both months.
// - A month's total is known only if it has an opening balance or the ledger
//   already existed when that month began anywhere on Earth; otherwise
//   reservations in it are refused.
//
// Integration contract for the later GitHub Actions jobs (ledger kept as
// `tech-brief-ledger.jsonl` on a dedicated branch; one writer at a time):
// 1. Fetch the branch; `reserve --id <unique per job attempt>` validates the
//    ledger, checks every month the run can touch, appends the reservation
//    and prints monthSpentUsd.
// 2. Commit and push without force. A rejected push means another writer won:
//    reset to the remote and run `reserve` again (it recomputes everything).
//    Never merge ledger branches.
// 3. Fetch again and run `verify --contains <id>` against the remote copy.
//    Only then may paid research start.
// 4. Pass `month-spent --id <id>` (equal to the printed monthSpentUsd) to
//    research.mjs as --month-spent. It excludes the run's own reservation,
//    because research.mjs adds the per-run ceiling itself: spent + ceiling <=
//    monthly budget is the same condition the reservation already checked.
// 5. After research, `settle --id <id> --report report.json` (same push and
//    verify loop). Settlement is idempotent: repeating it is a no-op, and a
//    different figure for the same run is refused.
// 6. If settlement cannot complete, do nothing: the full reservation stays.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { isSaturdayDate } from "./schedule.mjs";

export const LEDGER_SCHEMA = "ourfaces-tech-brief-ledger/1";
export const ZONE_SPREAD = Object.freeze({ behindHours: 12, aheadHours: 14 });
// Longest time a research run is assumed to spend money after reserving.
export const RUN_ALLOWANCE_HOURS = 6;
export const REASONS = Object.freeze({
  opening: ["opening-balance"],
  adjust: ["provider-reconciliation", "external-run", "correction"],
  settle: ["crash-unknown", "provider-reconciliation"],
});

const ZERO_HASH = "0".repeat(64);
const HOUR = 3_600_000;
const CLOCK_SKEW_MS = 10 * 60_000;
const MAX_MICRO = 10_000_000; // $10: far above any legitimate single figure
const RESEARCH_STATUSES = [
  "edition",
  "no-edition",
  "budget-stop",
  "error",
  "blocked",
];
const FIELDS = {
  init: ["seq", "type", "prev", "at", "schema"],
  opening: [
    "seq",
    "type",
    "prev",
    "at",
    "month",
    "amountMicroUsd",
    "reason",
    "ref",
  ],
  adjust: [
    "seq",
    "type",
    "prev",
    "at",
    "month",
    "amountMicroUsd",
    "reason",
    "ref",
  ],
  reserve: [
    "seq",
    "type",
    "prev",
    "at",
    "id",
    "edition",
    "kind",
    "amountMicroUsd",
    "supersedes",
  ],
  settle: [
    "seq",
    "type",
    "prev",
    "at",
    "id",
    "source",
    "status",
    "countedMicroUsd",
    "reportRunId",
    "finishedAt",
    "reason",
  ],
};
const ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const REF = /^[A-Za-z0-9._-]{1,64}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const RUN_ID = /^run-[0-9a-f]{8}$/;

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new LedgerError(code, message);
};

const sha256 = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const serialize = (record) =>
  JSON.stringify(
    Object.fromEntries(FIELDS[record.type].map((k) => [k, record[k]])),
  );
const isInstant = (value) =>
  typeof value === "string" &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const isMicro = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= MAX_MICRO;

/** USD as a decimal string ("0.75", "-0.1") or number -> whole micro-dollars. */
export function usdToMicro(value) {
  if (typeof value === "string") {
    const m = /^(-)?(\d{1,6})(?:\.(\d{1,6}))?$/.exec(value);
    if (!m)
      fail(
        "INVALID_INPUT",
        `Not a USD amount with at most 6 decimals: ${value}`,
      );
    const micro =
      Number(m[2]) * 1_000_000 + Number((m[3] ?? "").padEnd(6, "0"));
    return m[1] ? -micro : micro;
  }
  if (typeof value !== "number" || !Number.isFinite(value))
    fail("INVALID_INPUT", `Not a USD amount: ${value}`);
  const micro = Math.round(value * 1_000_000);
  if (Math.abs(micro - value * 1_000_000) > 1e-3)
    fail("INVALID_INPUT", `More than 6 decimals: ${value}`);
  return micro;
}
const microToUsd = (micro) => micro / 1_000_000;

/** Field-level checks for one record; returns a problem or null. */
function recordProblem(r) {
  if (!isInstant(r.at)) return "at must be an ISO 8601 UTC instant";
  switch (r.type) {
    case "init":
      return r.schema === LEDGER_SCHEMA ? null : "unknown schema";
    case "opening":
    case "adjust": {
      if (typeof r.month !== "string" || !MONTH.test(r.month))
        return "month must be YYYY-MM";
      if (!REASONS[r.type].includes(r.reason)) return `reason ${r.reason}`;
      if (r.ref !== null && !(typeof r.ref === "string" && REF.test(r.ref)))
        return "ref must be a short token";
      if (
        !Number.isSafeInteger(r.amountMicroUsd) ||
        Math.abs(r.amountMicroUsd) > MAX_MICRO
      )
        return "amount out of range";
      if (
        r.amountMicroUsd < 0 &&
        !(r.type === "adjust" && r.reason !== "external-run")
      )
        return "only reconciliations and corrections may be negative";
      return null;
    }
    case "reserve":
      if (typeof r.id !== "string" || !ID.test(r.id)) return "id";
      if (!isSaturdayDate(r.edition)) return "edition must be a Saturday";
      if (!["scheduled", "manual"].includes(r.kind)) return "kind";
      if (!isMicro(r.amountMicroUsd) || r.amountMicroUsd === 0) return "amount";
      if (
        r.supersedes !== null &&
        !(typeof r.supersedes === "string" && ID.test(r.supersedes))
      )
        return "supersedes";
      return null;
    case "settle": {
      if (typeof r.id !== "string" || !ID.test(r.id)) return "id";
      if (!isMicro(r.countedMicroUsd)) return "counted amount out of range";
      if (r.source === "report")
        return RESEARCH_STATUSES.includes(r.status) &&
          typeof r.reportRunId === "string" &&
          RUN_ID.test(r.reportRunId) &&
          isInstant(r.finishedAt) &&
          r.reason === null
          ? null
          : "report settlement fields";
      if (r.source === "manual")
        return r.status === "unknown" &&
          r.reportRunId === null &&
          r.finishedAt === null &&
          REASONS.settle.includes(r.reason)
          ? null
          : "manual settlement fields";
      return "source";
    }
    default:
      return "unknown type";
  }
}

const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7);
function monthsBetween(startMs, endMs) {
  const months = [];
  let [year, month] = monthKey(startMs).split("-").map(Number);
  const last = monthKey(endMs);
  for (;;) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    months.push(key);
    if (key === last) return months;
    if (++month === 13) [year, month] = [year + 1, 1];
  }
}

/** Calendar months a run reserved at `reservedAt` can be billed in. */
export function runMonths(reservedAt, finishedAt = null) {
  const start = Date.parse(reservedAt);
  const end = Math.max(
    start + RUN_ALLOWANCE_HOURS * HOUR,
    finishedAt === null ? 0 : Date.parse(finishedAt),
  );
  return monthsBetween(
    start - ZONE_SPREAD.behindHours * HOUR,
    end + ZONE_SPREAD.aheadHours * HOUR,
  );
}

function applyRecord(state, r, where) {
  const corrupt = (message) => fail("LEDGER_CORRUPT", `${where}: ${message}`);
  switch (r.type) {
    case "init":
      state.init = r;
      return;
    case "opening":
      if (state.openings.has(r.month))
        corrupt(`second opening balance for ${r.month}`);
      state.openings.set(r.month, r);
      return;
    case "adjust":
      state.adjustments.push(r);
      return;
    case "reserve": {
      if (state.reservations.has(r.id))
        corrupt(`duplicate reservation ${r.id}`);
      const current = currentReservation(state, r.edition);
      if ((current?.reserve.id ?? null) !== r.supersedes)
        corrupt(
          current
            ? `${r.id} overlaps unsettled reservation ${current.reserve.id}`
            : `${r.id} supersedes ${r.supersedes}, which is not current`,
        );
      if (current) current.supersededBy = r.id;
      state.reservations.set(r.id, {
        reserve: r,
        settlement: null,
        supersededBy: null,
      });
      return;
    }
    case "settle": {
      const entry = state.reservations.get(r.id);
      if (!entry) corrupt(`settlement for unknown reservation ${r.id}`);
      if (entry.settlement) corrupt(`second settlement for ${r.id}`);
      if (
        r.finishedAt !== null &&
        Date.parse(r.finishedAt) < Date.parse(entry.reserve.at) - CLOCK_SKEW_MS
      )
        corrupt(`${r.id} finished before it was reserved`);
      entry.settlement = r;
      return;
    }
  }
}

/**
 * Parses and fully validates ledger text. Any problem throws LEDGER_MISSING
 * or LEDGER_CORRUPT; callers never act on a partially valid ledger.
 */
export function parseLedger(raw, { now = new Date() } = {}) {
  if (typeof raw !== "string" || raw.length === 0)
    fail("LEDGER_MISSING", "The ledger is empty");
  // A Windows checkout may convert line endings; hashes cover the line text only.
  const text = raw.replaceAll("\r\n", "\n");
  if (!text.endsWith("\n"))
    fail("LEDGER_CORRUPT", "The last record is incomplete (no final newline)");
  const state = {
    init: null,
    openings: new Map(),
    adjustments: [],
    reservations: new Map(),
    records: [],
    hashes: [],
    head: ZERO_HASH,
  };
  text
    .slice(0, -1)
    .split("\n")
    .forEach((line, i) => {
      const where = `record ${i + 1}`;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        fail("LEDGER_CORRUPT", `${where} is not JSON`);
      }
      if (!r || typeof r !== "object" || Array.isArray(r) || !FIELDS[r.type])
        fail("LEDGER_CORRUPT", `${where} has an unknown type`);
      const fields = FIELDS[r.type];
      if (
        Object.keys(r).length !== fields.length ||
        !fields.every((k) => Object.hasOwn(r, k)) ||
        serialize(r) !== line
      )
        fail("LEDGER_CORRUPT", `${where} is not in canonical form`);
      if (r.seq !== i + 1) fail("LEDGER_CORRUPT", `${where} has seq ${r.seq}`);
      if (r.prev !== state.head)
        fail("LEDGER_CORRUPT", `${where} breaks the hash chain`);
      if ((i === 0) !== (r.type === "init"))
        fail(
          "LEDGER_CORRUPT",
          `${where}: the ledger must start with one init record`,
        );
      const problem = recordProblem(r);
      if (problem) fail("LEDGER_CORRUPT", `${where}: ${problem}`);
      if (Date.parse(r.at) > now.getTime() + CLOCK_SKEW_MS)
        fail("LEDGER_CORRUPT", `${where} is dated in the future`);
      applyRecord(state, r, where);
      state.records.push(r);
      state.head = sha256(line);
      state.hashes.push(state.head);
    });
  for (const month of new Set([
    ...state.openings.keys(),
    ...state.adjustments.map((a) => a.month),
  ]))
    if (
      (state.openings.get(month)?.amountMicroUsd ?? 0) +
        state.adjustments
          .filter((a) => a.month === month)
          .reduce((t, a) => t + a.amountMicroUsd, 0) <
      0
    )
      fail("LEDGER_CORRUPT", `${month}: opening and adjustments are negative`);
  return state;
}

/** Ledger text for records (adds seq and prev); parseLedger still validates it. */
export function formatLedger(records) {
  let prev = ZERO_HASH;
  return records
    .map((r, i) => {
      const line = serialize({ ...r, seq: i + 1, prev });
      prev = sha256(line);
      return `${line}\n`;
    })
    .join("");
}

function currentReservation(state, edition) {
  for (const entry of state.reservations.values())
    if (
      entry.reserve.edition === edition &&
      !entry.settlement &&
      !entry.supersededBy
    )
      return entry;
  return null;
}
const entryMonths = (entry) =>
  runMonths(entry.reserve.at, entry.settlement?.finishedAt ?? null);
const entryCharge = (entry) =>
  entry.settlement
    ? entry.settlement.countedMicroUsd
    : entry.reserve.amountMicroUsd;

/** True when every spend in `month` is in the ledger (see header). */
export function monthKnown(state, month) {
  return (
    state.openings.has(month) ||
    Date.parse(state.init.at) <=
      Date.parse(`${month}-01T00:00:00.000Z`) - ZONE_SPREAD.aheadHours * HOUR
  );
}

/** Counted spend for a month: opening + adjustments + every run that can fall in it. */
export function monthTotalMicro(state, month) {
  let total = state.openings.get(month)?.amountMicroUsd ?? 0;
  for (const a of state.adjustments)
    if (a.month === month) total += a.amountMicroUsd;
  for (const entry of state.reservations.values())
    if (entryMonths(entry).includes(month)) total += entryCharge(entry);
  return total;
}

/** Month totals and unsettled reservations, for status output and the workflow summary. */
export function ledgerSummary(state) {
  const months = new Set([
    ...state.openings.keys(),
    ...state.adjustments.map((a) => a.month),
    ...[...state.reservations.values()].flatMap(entryMonths),
  ]);
  return {
    head: state.head,
    records: state.records.length,
    months: [...months].sort().map((month) => ({
      month,
      known: monthKnown(state, month),
      countedUsd: microToUsd(monthTotalMicro(state, month)),
    })),
    unsettled: [...state.reservations.values()]
      .filter((e) => !e.settlement)
      .map((e) => ({
        id: e.reserve.id,
        edition: e.reserve.edition,
        kind: e.reserve.kind,
        reservedAt: e.reserve.at,
        amountUsd: microToUsd(e.reserve.amountMicroUsd),
        supersededBy: e.supersededBy,
      })),
  };
}

const budgetOf = (config) => ({
  reserveMicro: usdToMicro(config.budget.perRunUsd),
  monthlyMicro: usdToMicro(config.budget.monthlyUsd),
});

/** Checks a new reservation against the ledger; returns the record to append. */
export function planReservation(
  state,
  { id, edition, kind, supersedes = null, at, config },
) {
  if (typeof id !== "string" || !ID.test(id))
    fail("INVALID_INPUT", `Reservation id must match ${ID}`);
  if (!isSaturdayDate(edition))
    fail("INVALID_INPUT", "Edition must be a Saturday");
  if (!["scheduled", "manual"].includes(kind))
    fail("INVALID_INPUT", "Kind must be scheduled or manual");
  const { reserveMicro, monthlyMicro } = budgetOf(config);
  if (reserveMicro <= 0 || reserveMicro > monthlyMicro)
    fail(
      "INVALID_INPUT",
      "The per-run reservation must be positive and within the monthly budget",
    );
  if (state.reservations.has(id))
    fail(
      "DUPLICATE_RESERVATION",
      `Reservation ${id} already exists; every attempt needs a new id`,
    );
  const current = currentReservation(state, edition);
  if (current && supersedes !== current.reserve.id)
    fail(
      "ACTIVE_RESERVATION",
      `Reservation ${current.reserve.id} for ${edition} is unsettled; a recovery run must name it with supersedes (it stays counted)`,
    );
  if (!current && supersedes !== null)
    fail(
      "INVALID_INPUT",
      `${supersedes} is not an unsettled reservation for ${edition}`,
    );
  const months = runMonths(at.toISOString());
  let spent = 0;
  for (const month of months) {
    if (!monthKnown(state, month))
      fail(
        "MONTH_UNKNOWN",
        `No opening balance for ${month}; month-to-date spend is unknown`,
      );
    const total = monthTotalMicro(state, month);
    if (total + reserveMicro > monthlyMicro)
      fail(
        "BUDGET_EXCEEDED",
        `${month}: $${microToUsd(total)} counted + $${microToUsd(reserveMicro)} reservation exceeds $${microToUsd(monthlyMicro)}`,
      );
    spent = Math.max(spent, total);
  }
  return {
    record: {
      type: "reserve",
      at: at.toISOString(),
      id,
      edition,
      kind,
      amountMicroUsd: reserveMicro,
      supersedes,
    },
    months,
    monthSpentUsd: microToUsd(spent),
  };
}

/**
 * The --month-spent value for research.mjs: the highest counted total among
 * the run's months, minus the run's own reservation (research.mjs adds its
 * per-run ceiling itself). Only for a current, unsettled reservation.
 */
export function monthSpentForReservation(state, id) {
  const entry = state.reservations.get(id);
  if (!entry) fail("NOT_FOUND", `No reservation ${id}`);
  if (entry.settlement || entry.supersededBy)
    fail(
      "NOT_ACTIVE",
      `Reservation ${id} is settled or superseded; reserve again`,
    );
  return microToUsd(
    Math.max(
      ...entryMonths(entry).map(
        (m) => monthTotalMicro(state, m) - entry.reserve.amountMicroUsd,
      ),
    ),
  );
}

function settlementRecord(entry, record) {
  if (!entry.settlement) return { record, alreadySettled: false };
  const same = [
    "source",
    "status",
    "countedMicroUsd",
    "reportRunId",
    "finishedAt",
    "reason",
  ].every((k) => entry.settlement[k] === record[k]);
  if (!same)
    fail(
      "SETTLEMENT_CONFLICT",
      `Reservation ${record.id} is already settled differently`,
    );
  return { record: null, alreadySettled: true };
}

/** Settlement from the run's research report; only the figures listed are kept. */
export function planReportSettlement(state, { id, report, at }) {
  const entry = state.reservations.get(id);
  if (!entry) fail("NOT_FOUND", `No reservation ${id}`);
  const reservedAt = Date.parse(entry.reserve.at);
  const mismatch = (message) => fail("REPORT_MISMATCH", `${id}: ${message}`);
  if (!report || typeof report !== "object") mismatch("no report");
  if (typeof report.runId !== "string" || !RUN_ID.test(report.runId))
    mismatch("report runId");
  if (!RESEARCH_STATUSES.includes(report.status)) mismatch("report status");
  if (report.edition !== entry.reserve.edition)
    mismatch(
      `report is for edition ${report.edition}, reservation for ${entry.reserve.edition}`,
    );
  if (!isInstant(report.startedAt) || !isInstant(report.finishedAt))
    mismatch("report times");
  const started = Date.parse(report.startedAt);
  const finished = Date.parse(report.finishedAt);
  if (
    started < reservedAt - CLOCK_SKEW_MS ||
    started > reservedAt + RUN_ALLOWANCE_HOURS * HOUR
  )
    mismatch("the report did not start within this reservation's run window");
  if (finished < started || finished > started + 24 * HOUR)
    mismatch("report duration");
  const counted = report.budget?.runTotalCountedUsd;
  if (typeof counted !== "number") mismatch("report has no counted cost");
  const countedMicro = usdToMicro(counted);
  if (!isMicro(countedMicro))
    fail("INVALID_INPUT", `Counted cost out of range: ${counted}`);
  return settlementRecord(entry, {
    type: "settle",
    at: at.toISOString(),
    id,
    source: "report",
    status: report.status,
    countedMicroUsd: countedMicro,
    reportRunId: report.runId,
    finishedAt: report.finishedAt,
    reason: null,
  });
}

/**
 * Manual settlement of a run without a usable report. "crash-unknown" keeps
 * the full reservation; "provider-reconciliation" records a figure taken from
 * the provider's usage page.
 */
export function planManualSettlement(
  state,
  { id, reason, countedUsd = null, at },
) {
  const entry = state.reservations.get(id);
  if (!entry) fail("NOT_FOUND", `No reservation ${id}`);
  if (!REASONS.settle.includes(reason))
    fail("INVALID_INPUT", `Reason must be one of ${REASONS.settle}`);
  let countedMicro = entry.reserve.amountMicroUsd;
  if (reason === "crash-unknown") {
    if (countedUsd !== null)
      fail(
        "INVALID_INPUT",
        "crash-unknown keeps the full reservation; use provider-reconciliation for a figure",
      );
  } else {
    if (countedUsd === null)
      fail(
        "INVALID_INPUT",
        "provider-reconciliation needs the reconciled amount",
      );
    countedMicro = usdToMicro(countedUsd);
    if (!isMicro(countedMicro))
      fail("INVALID_INPUT", "Reconciled amount out of range");
  }
  return settlementRecord(entry, {
    type: "settle",
    at: at.toISOString(),
    id,
    source: "manual",
    status: "unknown",
    countedMicroUsd: countedMicro,
    reportRunId: null,
    finishedAt: null,
    reason,
  });
}

function planBalance(state, type, { month, usd, reason, ref = null, at }) {
  if (typeof month !== "string" || !MONTH.test(month))
    fail("INVALID_INPUT", "Month must be YYYY-MM");
  if (type === "opening" && state.openings.has(month))
    fail(
      "DUPLICATE_OPENING",
      `${month} already has an opening balance; use an adjustment`,
    );
  const record = {
    type,
    at: at.toISOString(),
    month,
    amountMicroUsd: usdToMicro(usd),
    reason,
    ref,
  };
  const problem = recordProblem(record);
  if (problem) fail("INVALID_INPUT", problem);
  return { record };
}

// --- File operations: one writer at a time, atomic replacement -------------------------

export function readLedger(path, { now = new Date() } = {}) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") fail("LEDGER_MISSING", `No ledger at ${path}`);
    throw error;
  }
  const state = parseLedger(text, { now });
  return { text: text.replaceAll("\r\n", "\n"), state };
}

function atomicWrite(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing more to clean up
    }
    throw error;
  }
}

function withLock(path, fn) {
  const lock = `${path}.lock`;
  let fd;
  try {
    fd = openSync(lock, "wx");
  } catch (error) {
    if (error.code === "EEXIST")
      fail(
        "LOCKED",
        `${lock} exists: another update is running, or one crashed (check before removing it)`,
      );
    throw error;
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

/** Validates, plans and appends one record under the lock. */
function update(path, at, plan) {
  return withLock(path, () => {
    const { text, state } = readLedger(path, { now: at });
    const planned = plan(state);
    if (!planned.record)
      return { ...planned, head: state.head, appended: false };
    const record = {
      seq: state.records.length + 1,
      prev: state.head,
      ...planned.record,
    };
    const next = `${text}${serialize(record)}\n`;
    const after = parseLedger(next, { now: at }); // the new ledger must validate
    atomicWrite(path, next);
    return { ...planned, record, head: after.head, appended: true };
  });
}

export function initLedger(path, { at = new Date() } = {}) {
  if (existsSync(path)) fail("LEDGER_EXISTS", `${path} already exists`);
  const record = {
    seq: 1,
    type: "init",
    prev: ZERO_HASH,
    at: at.toISOString(),
    schema: LEDGER_SCHEMA,
  };
  const text = `${serialize(record)}\n`;
  parseLedger(text, { now: at });
  return withLock(path, () => {
    if (existsSync(path)) fail("LEDGER_EXISTS", `${path} already exists`);
    atomicWrite(path, text);
    return { record, head: sha256(serialize(record)), appended: true };
  });
}
export const recordOpening = (path, { at = new Date(), ...input }) =>
  update(path, at, (s) =>
    planBalance(s, "opening", { reason: "opening-balance", ...input, at }),
  );
export const recordAdjustment = (path, { at = new Date(), ...input }) =>
  update(path, at, (s) => planBalance(s, "adjust", { ...input, at }));
export const reserve = (path, { at = new Date(), ...input }) =>
  update(path, at, (s) => planReservation(s, { ...input, at }));
export const settleFromReport = (path, { at = new Date(), ...input }) =>
  update(path, at, (s) => planReportSettlement(s, { ...input, at }));
export const settleManually = (path, { at = new Date(), ...input }) =>
  update(path, at, (s) => planManualSettlement(s, { ...input, at }));

// CLI ------------------------------------------------------------------------------------------
// node scripts/tech-brief/ledger.mjs <command> --ledger PATH [--now ISO] ...
//   init
//   opening --month YYYY-MM --usd AMOUNT [--ref TOKEN]
//   adjust --month YYYY-MM --usd AMOUNT --reason REASON [--ref TOKEN]
//   reserve --id ID --edition YYYY-MM-DD --kind scheduled|manual [--supersedes ID]
//   month-spent --id ID
//   settle --id ID --report PATH
//   settle --id ID --manual --reason REASON [--usd AMOUNT]
//   status
//   verify [--contains ID]
// Prints one JSON object. Exit 0 ok, 3 budget exceeded, 4 refused or invalid
// ledger (fail closed), 1 usage error.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, ...args] = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? "") : null;
  };
  const out = (code, value) => {
    console.log(JSON.stringify(value));
    process.exit(code);
  };
  const path = option("--ledger");
  const at = option("--now") === null ? new Date() : new Date(option("--now"));
  if (!path || Number.isNaN(at.getTime()))
    out(1, {
      ok: false,
      code: "USAGE",
      message: "--ledger PATH is required (and --now must be a valid time)",
    });
  const config = () =>
    JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
  try {
    let result;
    switch (command) {
      case "init":
        result = initLedger(path, { at });
        break;
      case "opening":
        result = recordOpening(path, {
          at,
          month: option("--month"),
          usd: option("--usd"),
          ref: option("--ref"),
        });
        break;
      case "adjust":
        result = recordAdjustment(path, {
          at,
          month: option("--month"),
          usd: option("--usd"),
          reason: option("--reason"),
          ref: option("--ref"),
        });
        break;
      case "reserve":
        result = reserve(path, {
          at,
          id: option("--id"),
          edition: option("--edition"),
          kind: option("--kind"),
          supersedes: option("--supersedes"),
          config: config(),
        });
        break;
      case "month-spent": {
        const { state } = readLedger(path, { now: at });
        result = {
          id: option("--id"),
          monthSpentUsd: monthSpentForReservation(state, option("--id")),
        };
        break;
      }
      case "settle":
        result = args.includes("--manual")
          ? settleManually(path, {
              at,
              id: option("--id"),
              reason: option("--reason"),
              countedUsd: option("--usd"),
            })
          : settleFromReport(path, {
              at,
              id: option("--id"),
              report: JSON.parse(
                readFileSync(option("--report") ?? "", "utf8"),
              ),
            });
        break;
      case "status":
        result = ledgerSummary(readLedger(path, { now: at }).state);
        break;
      case "verify": {
        const { state } = readLedger(path, { now: at });
        const id = option("--contains");
        const index = state.records.findIndex(
          (r) => r.type === "reserve" && r.id === id,
        );
        if (id !== null && index < 0)
          throw new LedgerError(
            "NOT_FOUND",
            `The ledger does not contain reservation ${id}`,
          );
        result = {
          head: state.head,
          records: state.records.length,
          ...(id !== null
            ? { contains: id, recordHash: state.hashes[index] }
            : {}),
        };
        break;
      }
      default:
        out(1, {
          ok: false,
          code: "USAGE",
          message: `Unknown command ${command}`,
        });
    }
    out(0, { ok: true, command, ...result });
  } catch (error) {
    if (error instanceof LedgerError)
      out(error.code === "BUDGET_EXCEEDED" ? 3 : 4, {
        ok: false,
        code: error.code,
        message: error.message,
      });
    out(4, { ok: false, code: "ERROR", message: error.message });
  }
}
