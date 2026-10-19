// Phase 4 GitHub Actions glue (automation.mjs), offline: the activation gate,
// planning, ledger transactions against local bare Git remotes (concurrent
// writers, rejected pushes, budget, corruption, interrupted settlement), the
// full Saturday -> Sunday flow with synthetic GitHub records and a synthetic
// research result, the public-change check, live verification with a mocked
// fetch, the rehearsal and CLI smoke tests. No network, no real credentials.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LEDGER_BRANCH,
  LEDGER_FILE,
  REHEARSAL_KEY,
  RESEARCH_WORKFLOW_PATH,
  checkPublicationChanges,
  gate,
  gitIsAncestor,
  keysFromEnvironment,
  ledgerTransaction,
  planPublication,
  planResearch,
  reserveStep,
  reservationId,
  runGit,
  settleStep,
  singleFile,
  sundayPrepare,
  verifyLive,
} from "../automation.mjs";
import { sealBundle } from "../bundle.mjs";
import {
  initLedger,
  readLedger,
  recordOpening,
  settlementSummary,
} from "../ledger.mjs";
import { bundleArtifactName, workflowRefOf } from "../provenance.mjs";
import {
  REHEARSAL_RUN_ID,
  REHEARSAL_WORKFLOW_PATH,
  fixtureFetcher,
  rehearsalClock,
  rehearsalResult,
  rehearseSunday,
} from "../rehearsal.mjs";
import { loadConfig } from "../research.mjs";
import { editionSchedule } from "../schedule.mjs";
import { loadSourcePolicy } from "../validate.mjs";

// Git runs with no global or system configuration (no signing, no autocrlf).
const GIT_HOME = mkdtempSync(join(tmpdir(), "tb-auto-gitcfg-"));
writeFileSync(join(GIT_HOME, "gitconfig"), "");
process.env.GIT_CONFIG_GLOBAL = join(GIT_HOME, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
const ME = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
const git = (dir, ...args) => runGit(dir, args);

const config = await loadConfig();
const REAL_POLICY = await loadSourcePolicy(
  new URL("../sources.json", import.meta.url),
);
// TEST-ONLY approved copy; the real sources.json stays as it is.
const APPROVED = Object.freeze({ ...REAL_POLICY, status: "approved" });
const EDITION = "2026-10-24";
const RESERVED_AT = new Date("2026-10-25T00:17:00.000Z"); // Sat 20:17 EDT
const SUNDAY = rehearsalClock(EDITION); // Sun 20:10 EDT
const KEY = createHash("sha256").update("ourfaces test-only key A").digest();
const OTHER_KEY = createHash("sha256")
  .update("ourfaces test-only key B")
  .digest();
const SHA = "0123456789abcdef0123456789abcdef01234567";
const EXPECTED = Object.freeze({
  repository: "owner/ourfaces-site",
  repositoryId: 123456,
  workflowPath: RESEARCH_WORKFLOW_PATH,
  branch: "main",
  events: ["schedule", "workflow_dispatch"],
});
const CONTENT = fileURLToPath(
  new URL("../../../src/content/tech-brief/", import.meta.url),
);
const AUTOMATION = fileURLToPath(new URL("../automation.mjs", import.meta.url));
const REHEARSAL = fileURLToPath(new URL("../rehearsal.mjs", import.meta.url));

const codeOf = async (fn) => {
  try {
    await fn();
  } catch (error) {
    return error?.code ?? `UNCODED: ${error?.message}`;
  }
  return "NO_ERROR";
};
const temp = (name) => mkdtempSync(join(tmpdir(), `tb-auto-${name}-`));

// --- Local Git remotes ---------------------------------------------------------------------

/** A bare remote with the ledger branch (init + October opening) and a clone of it. */
function ledgerRemote({ openingUsd = "0.536" } = {}) {
  const root = temp("ledger");
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  const seed = join(root, "seed");
  execFileSync("git", ["init", "-q", "-b", LEDGER_BRANCH, seed]);
  const path = join(seed, LEDGER_FILE);
  initLedger(path, { at: new Date("2026-09-20T00:00:00.000Z") });
  recordOpening(path, {
    month: "2026-10",
    usd: openingUsd,
    ref: "test",
    at: new Date("2026-10-01T00:00:00.000Z"),
  });
  git(seed, "add", LEDGER_FILE);
  git(seed, ...ME, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", `HEAD:${LEDGER_BRANCH}`);
  return {
    root,
    remote,
    seed,
    clone: (name) => cloneLedger(remote, join(root, name)),
  };
}
function cloneLedger(remote, dir) {
  execFileSync("git", ["clone", "-q", "--branch", LEDGER_BRANCH, remote, dir]);
  return dir;
}
const remoteLedger = (remote) =>
  execFileSync(
    "git",
    ["--git-dir", remote, "show", `${LEDGER_BRANCH}:${LEDGER_FILE}`],
    { encoding: "utf8" },
  );
const remoteState = (remote, now = SUNDAY) => {
  const dir = temp("read");
  writeFileSync(join(dir, LEDGER_FILE), remoteLedger(remote));
  return readLedger(join(dir, LEDGER_FILE), { now }).state;
};

/** Saturday's ledger and sealing steps, as the workflow runs them. */
function saturday(
  clone,
  {
    runId = 9100000001,
    attempt = 1,
    artifactId = 4100000001,
    at = RESERVED_AT,
    supersedes = null,
    key = KEY,
    edition = EDITION,
    result = null,
    kind = "scheduled",
  } = {},
) {
  const id = reservationId(runId, attempt);
  const reserved = ledgerTransaction({
    dir: clone,
    message: "reserve",
    now: () => at,
    apply: reserveStep({ id, edition, kind, supersedes, config, at }),
  });
  const research = result ?? productionResult(edition, at);
  const sealed = sealBundle({
    report: research.report,
    draft: research.draft,
    workflow: workflowRefOf(EXPECTED),
    key,
  });
  const settled = ledgerTransaction({
    dir: clone,
    message: "settle",
    now: () => new Date(at.getTime() + 20 * 60_000),
    apply: settleStep({
      id,
      summary: settlementSummary(research.report),
      handoff: {
        workflowRunId: runId,
        runAttempt: attempt,
        artifactId,
        bundleDigest: sealed.digest,
      },
      at: new Date(at.getTime() + 20 * 60_000),
    }),
  });
  return { id, reserved, settled, sealed, research };
}

/** The synthetic research result, as a paid production run would report it. */
function productionResult(
  edition = EDITION,
  at = RESERVED_AT,
  runId = "run-1a2b3c4d",
) {
  const result = rehearsalResult(edition);
  const startedAt = new Date(at.getTime() + 3 * 60_000).toISOString();
  result.report = {
    ...result.report,
    runId,
    startedAt,
    finishedAt: new Date(at.getTime() + 8 * 60_000).toISOString(),
    budget: { runTotalCountedUsd: 0.191048 },
  };
  result.draft = {
    ...result.draft,
    generation: {
      ...result.draft.generation,
      runId,
      estimatedCostUsd: 0.191048,
    },
  };
  return result;
}

/** GitHub's artifact and run-attempt records for a handoff (synthetic). */
const records = ({
  runId = 9100000001,
  attempt = 1,
  artifactId = 4100000001,
  edition = EDITION,
  path = RESEARCH_WORKFLOW_PATH,
  artifact = {},
  run = {},
} = {}) => ({
  artifact: {
    id: artifactId,
    name: bundleArtifactName(edition, runId, attempt),
    size_in_bytes: 20000,
    expired: false,
    created_at: "2026-10-25T00:39:00Z",
    expires_at: "2027-01-23T00:39:00Z",
    workflow_run: {
      id: runId,
      repository_id: 123456,
      head_repository_id: 123456,
      head_branch: "main",
      head_sha: SHA,
    },
    ...artifact,
  },
  run: {
    id: runId,
    run_attempt: attempt,
    path,
    event: "schedule",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: SHA,
    repository: { id: 123456, full_name: "owner/ourfaces-site" },
    head_repository: { id: 123456, full_name: "owner/ourfaces-site" },
    ...run,
  },
});

/** A site repository (main, published content) with a bare remote. */
function siteRemote() {
  const root = temp("site");
  const remote = join(root, "site.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
  const dir = join(root, "work");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  mkdirSync(join(dir, "src/content"), { recursive: true });
  cpSync(CONTENT, join(dir, "src/content/tech-brief"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "site\n");
  git(dir, "add", ".");
  git(dir, ...ME, "commit", "-q", "-m", "site");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "HEAD:main");
  return { root, remote, dir, content: join(dir, "src/content/tech-brief") };
}
/** Sunday, as the publish job runs it. */
const sunday = ({
  remote,
  content,
  bytes,
  keys = [KEY],
  policy = APPROVED,
  recs = records(),
  now = SUNDAY,
  trigger = "schedule",
  edition = EDITION,
}) =>
  sundayPrepare({
    ledgerState: remoteState(remote, now),
    edition,
    ...recs,
    expected: EXPECTED,
    isMainCommit: (sha) => sha === SHA,
    bundleBytes: bytes,
    keys,
    policy,
    config,
    fetcher: fixtureFetcher(rehearsalResult(edition).pages),
    contentDir: content,
    now,
    trigger,
  });

// --- Activation gate and planning ----------------------------------------------------------

test("gate: production only for schedule or dispatch, enabled, on main, approved policy", () => {
  const ok = {
    event: "schedule",
    ref: "refs/heads/main",
    automation: "enabled",
    policy: APPROVED,
  };
  assert.equal(gate(ok).run, "production");
  assert.equal(gate({ ...ok, event: "workflow_dispatch" }).run, "production");
  for (const change of [
    { event: "push" },
    { event: "pull_request" },
    { event: "workflow_run" },
    { automation: undefined },
    { automation: "" },
    { automation: "Enabled" },
    { automation: "true" },
    { automation: "disabled" },
    { ref: "refs/heads/feature" },
    { ref: "refs/pull/1/merge" },
    { ref: "refs/tags/main" },
    { policy: REAL_POLICY },
    { policy: undefined },
  ])
    assert.equal(
      gate({ ...ok, ...change }).run,
      "skip",
      JSON.stringify(change),
    );
  assert.equal(
    REAL_POLICY.status === "approved",
    false,
    "the real policy stays unapproved",
  );
});

test("activation states: off does nothing, manual allows only dispatched runs, enabled allows both", async () => {
  const { clone, remote } = ledgerRemote();
  const dir = clone("states");
  const ledgerState = readLedger(join(dir, LEDGER_FILE), {
    now: RESERVED_AT,
  }).state;
  const research = (automation, event) =>
    planResearch({
      now: RESERVED_AT,
      event,
      ref: "refs/heads/main",
      automation,
      policy: APPROVED,
      edition: event === "workflow_dispatch" ? EDITION : null,
      ledgerState,
      publishedEdition: null,
    });
  const publication = (automation, event) =>
    planPublication({
      now: SUNDAY,
      event,
      ref: "refs/heads/main",
      automation,
      policy: APPROVED,
      edition: event === "workflow_dispatch" ? EDITION : null,
      publishedEdition: null,
    });
  const table = {};
  for (const automation of [
    undefined,
    "",
    "off",
    "manual",
    "enabled",
    "Manual",
    "ENABLED",
    "yes",
  ])
    for (const event of ["schedule", "workflow_dispatch"])
      table[`${automation} ${event}`] = [
        research(automation, event).run,
        publication(automation, event).run,
      ].join("/");
  assert.deepEqual(table, {
    "undefined schedule": "skip/skip",
    "undefined workflow_dispatch": "skip/skip",
    " schedule": "skip/skip",
    " workflow_dispatch": "skip/skip",
    "off schedule": "skip/skip",
    "off workflow_dispatch": "skip/skip",
    "manual schedule": "skip/skip",
    "manual workflow_dispatch": "production/production",
    "enabled schedule": "production/production",
    "enabled workflow_dispatch": "production/production",
    "Manual schedule": "skip/skip",
    "Manual workflow_dispatch": "skip/skip",
    "ENABLED schedule": "skip/skip",
    "ENABLED workflow_dispatch": "skip/skip",
    "yes schedule": "skip/skip",
    "yes workflow_dispatch": "skip/skip",
  });
  assert.match(research("manual", "schedule").reason, /Scheduled runs are off/);
  // Manual mode keeps every other requirement: main, approved policy, the
  // research cutoff and the publication window.
  assert.equal(
    gate({
      event: "workflow_dispatch",
      ref: "refs/heads/feature",
      automation: "manual",
      policy: APPROVED,
    }).run,
    "skip",
  );
  assert.equal(
    gate({
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      automation: "manual",
      policy: REAL_POLICY,
    }).run,
    "skip",
  );
  const early = planResearch({
    now: new Date("2026-10-24T23:00:00.000Z"),
    event: "workflow_dispatch",
    ref: "refs/heads/main",
    automation: "manual",
    policy: APPROVED,
    edition: EDITION,
    ledgerState,
    publishedEdition: null,
  });
  assert.deepEqual([early.run, early.code], ["skip", "EARLY"]);
  const beforeSunday = planPublication({
    now: RESERVED_AT,
    event: "workflow_dispatch",
    ref: "refs/heads/main",
    automation: "manual",
    policy: APPROVED,
    edition: EDITION,
    publishedEdition: null,
  });
  assert.deepEqual([beforeSunday.run, beforeSunday.code], ["skip", "EARLY"]);
  // A supervised manual week end to end: a manual reservation within the
  // budget, then a manual Sunday publication with all its checks.
  const { sealed, reserved } = saturday(dir, { kind: "manual" });
  assert.equal(reserved.monthSpentUsd, 0.536);
  const site = siteRemote();
  const outcome = await sunday({
    remote,
    content: site.content,
    bytes: sealed.bytes,
    recs: records({ run: { event: "workflow_dispatch" } }),
    trigger: "manual",
  });
  assert.equal(outcome.status, "prepared");
});

test("planResearch: schedules skip once any run reserved the edition; manual recovery stops only at a handoff", () => {
  const { clone } = ledgerRemote();
  const dir = clone("plan");
  const base = {
    now: RESERVED_AT,
    event: "schedule",
    ref: "refs/heads/main",
    automation: "enabled",
    policy: APPROVED,
    publishedEdition: null,
  };
  const state = () =>
    readLedger(join(dir, LEDGER_FILE), { now: RESERVED_AT }).state;
  assert.deepEqual(
    (({ run, edition, code }) => ({ run, edition, code }))(
      planResearch({ ...base, ledgerState: state() }),
    ),
    { run: "production", edition: EDITION, code: "DUE" },
  );
  assert.equal(
    planResearch({ ...base, automation: undefined, ledgerState: null }).run,
    "skip",
  );
  // A reservation without settlement (crash) or with a no-edition settlement: fallbacks do nothing.
  ledgerTransaction({
    dir,
    message: "r",
    now: () => RESERVED_AT,
    apply: reserveStep({
      id: "gh-1-1",
      edition: EDITION,
      kind: "scheduled",
      config,
      at: RESERVED_AT,
    }),
  });
  const fallback = {
    ...base,
    now: new Date("2026-10-25T02:47:00.000Z"),
    ledgerState: state(),
  };
  assert.deepEqual(
    [planResearch(fallback).run, planResearch(fallback).code],
    ["skip", "ALREADY_DONE"],
  );
  // Manual recovery is still possible until a handoff exists.
  const manual = { ...fallback, event: "workflow_dispatch", edition: EDITION };
  assert.deepEqual(
    [planResearch(manual).run, planResearch(manual).trigger],
    ["production", "manual"],
  );
  // Published editions are never researched again; the next week is due on its own schedule.
  assert.equal(
    planResearch({ ...manual, publishedEdition: EDITION }).code,
    "ALREADY_PUBLISHED",
  );
  assert.equal(
    planResearch({
      ...base,
      now: new Date("2026-11-01T01:17:00.000Z"),
      ledgerState: state(),
    }).edition,
    "2026-10-31",
  );
  // Before the cutoff and after the scheduled window.
  assert.equal(
    planResearch({
      ...base,
      now: new Date("2026-10-24T23:00:00.000Z"),
      ledgerState: state(),
    }).run,
    "skip",
  );
});

test("planResearch without a ledger fails closed", async () => {
  const code = await codeOf(() =>
    planResearch({
      now: RESERVED_AT,
      event: "schedule",
      ref: "refs/heads/main",
      automation: "enabled",
      policy: APPROVED,
      ledgerState: null,
      publishedEdition: null,
    }),
  );
  assert.equal(code, "LEDGER_MISSING");
});

test("planPublication: due on Sunday's schedule, skipped when published, disabled or early", () => {
  const base = {
    now: SUNDAY,
    event: "schedule",
    ref: "refs/heads/main",
    automation: "enabled",
    policy: APPROVED,
    publishedEdition: null,
  };
  assert.deepEqual(
    [planPublication(base).run, planPublication(base).edition],
    ["production", EDITION],
  );
  assert.equal(
    planPublication({ ...base, publishedEdition: EDITION }).code,
    "ALREADY_PUBLISHED",
  );
  assert.equal(
    planPublication({ ...base, automation: "disabled" }).run,
    "skip",
  );
  assert.equal(planPublication({ ...base, policy: REAL_POLICY }).run, "skip");
  assert.equal(planPublication({ ...base, now: RESERVED_AT }).code, "EARLY");
  // Scheduled window closed: only a manual recovery runs, until the next cutoff.
  const late = { ...base, now: new Date("2026-10-27T18:00:00.000Z") };
  assert.equal(planPublication(late).code, "MISSED");
  assert.equal(
    planPublication({ ...late, event: "workflow_dispatch", edition: EDITION })
      .run,
    "production",
  );
  assert.equal(
    planPublication({
      ...late,
      now: editionSchedule(EDITION).recoveryUntil,
      event: "workflow_dispatch",
      edition: EDITION,
    }).code,
    "STALE",
  );
});

// --- Ledger transactions on the ledger branch ----------------------------------------------

test("reserve and settle with handoff: pushed, durable, idempotent, month spend excludes the run's own reservation", () => {
  const { remote, clone } = ledgerRemote();
  const dir = clone("work");
  const { id, reserved, settled } = saturday(dir);
  assert.deepEqual(
    [reserved.pushed, reserved.attempt, reserved.monthSpentUsd],
    [true, 1, 0.536],
  );
  assert.equal(settled.pushed, true);
  const state = remoteState(remote);
  assert.equal(state.reservations.get(id).handoff.artifactId, 4100000001);
  // A second reservation (a manual run after the handoff) counts the settled cost;
  // repeating its reserve step changes nothing and pushes nothing.
  const later = new Date(RESERVED_AT.getTime() + 3_600_000);
  const step = reserveStep({
    id: "gh-9-1",
    edition: EDITION,
    kind: "manual",
    config,
    at: later,
  });
  const again = ledgerTransaction({
    dir,
    message: "x",
    now: () => later,
    apply: step,
  });
  assert.deepEqual([again.pushed, again.monthSpentUsd], [true, 0.727048]);
  const before = remoteLedger(remote);
  const repeat = ledgerTransaction({
    dir,
    message: "x",
    now: () => later,
    apply: step,
  });
  assert.deepEqual([repeat.pushed, repeat.monthSpentUsd], [false, 0.727048]);
  assert.equal(remoteLedger(remote), before);
});

test("a concurrent ledger writer wins the race: the push is retried from the remote", () => {
  const { remote, clone } = ledgerRemote();
  const dir = clone("work");
  const rival = clone("rival");
  let raced = false;
  const racing = (cwd, args) => {
    if (args[0] === "push" && !raced) {
      raced = true;
      recordOpening(join(rival, LEDGER_FILE), {
        month: "2026-11",
        usd: "0",
        ref: "rival",
        at: RESERVED_AT,
      });
      git(rival, "add", LEDGER_FILE);
      git(rival, ...ME, "commit", "-q", "-m", "rival");
      git(rival, "push", "-q", "origin", `HEAD:${LEDGER_BRANCH}`);
    }
    return runGit(cwd, args);
  };
  const result = ledgerTransaction({
    dir,
    git: racing,
    message: "r",
    now: () => RESERVED_AT,
    apply: reserveStep({
      id: "gh-1-1",
      edition: EDITION,
      kind: "scheduled",
      config,
      at: RESERVED_AT,
    }),
  });
  assert.deepEqual([result.pushed, result.attempt], [true, 2]);
  const state = remoteState(remote);
  assert.ok(state.reservations.has("gh-1-1"));
  assert.equal(
    state.records.filter((r) => r.type === "opening").length,
    2,
    "the rival's record is kept",
  );
});

test("rejected, lost or refused ledger writes fail closed and leave the remote unchanged", async () => {
  const { remote, clone } = ledgerRemote();
  const dir = clone("work");
  const before = remoteLedger(remote);
  const step = reserveStep({
    id: "gh-1-1",
    edition: EDITION,
    kind: "scheduled",
    config,
    at: RESERVED_AT,
  });
  const rejecting = (cwd, args) => {
    if (args[0] === "push")
      throw Object.assign(new Error("rejected"), { status: 1 });
    return runGit(cwd, args);
  };
  assert.equal(
    await codeOf(() =>
      ledgerTransaction({
        dir,
        git: rejecting,
        message: "r",
        now: () => RESERVED_AT,
        apply: step,
      }),
    ),
    "LEDGER_CONFLICT",
  );
  // A push that reports success but never reaches the remote.
  const lying = (cwd, args) => (args[0] === "push" ? "" : runGit(cwd, args));
  assert.equal(
    await codeOf(() =>
      ledgerTransaction({
        dir,
        git: lying,
        message: "r",
        now: () => RESERVED_AT,
        apply: step,
      }),
    ),
    "LEDGER_NOT_DURABLE",
  );
  assert.equal(remoteLedger(remote), before);
  // The ledger branch must already exist: nothing is created.
  assert.match(
    await codeOf(() =>
      ledgerTransaction({
        dir,
        branch: "no-such-branch",
        message: "r",
        now: () => RESERVED_AT,
        apply: step,
      }),
    ),
    /UNCODED/,
  );
  assert.equal(
    execFileSync(
      "git",
      ["--git-dir", remote, "for-each-ref", "--format=%(refname)"],
      { encoding: "utf8" },
    ).trim(),
    `refs/heads/${LEDGER_BRANCH}`,
  );
});

test("budget exhaustion and a corrupt ledger are refused before any push", async () => {
  const pushes = [];
  const counting = (cwd, args) => {
    if (args[0] === "push") pushes.push(args);
    return runGit(cwd, args);
  };
  const full = ledgerRemote({ openingUsd: "3.5" });
  const step = reserveStep({
    id: "gh-1-1",
    edition: EDITION,
    kind: "scheduled",
    config,
    at: RESERVED_AT,
  });
  assert.equal(
    await codeOf(() =>
      ledgerTransaction({
        dir: full.clone("w"),
        git: counting,
        message: "r",
        now: () => RESERVED_AT,
        apply: step,
      }),
    ),
    "BUDGET_EXCEEDED",
  );
  // An edited earlier record breaks the hash chain.
  const corrupt = ledgerRemote();
  const text = readFileSync(join(corrupt.seed, LEDGER_FILE), "utf8");
  assert.ok(text.includes("2026-09-20T00:00:00.000Z"));
  writeFileSync(
    join(corrupt.seed, LEDGER_FILE),
    text.replace("2026-09-20T00:00:00.000Z", "2026-09-21T00:00:00.000Z"),
  );
  git(corrupt.seed, ...ME, "commit", "-q", "-am", "tamper");
  git(corrupt.seed, "push", "-q", "origin", `HEAD:${LEDGER_BRANCH}`);
  assert.equal(
    await codeOf(() =>
      ledgerTransaction({
        dir: corrupt.clone("w"),
        git: counting,
        message: "r",
        now: () => RESERVED_AT,
        apply: step,
      }),
    ),
    "LEDGER_CORRUPT",
  );
  assert.deepEqual(pushes, []);
});

test("interrupted settlement: the reservation stays counted, schedules stop, recovery must supersede it", async () => {
  const { remote, clone } = ledgerRemote();
  const dir = clone("work");
  ledgerTransaction({
    dir,
    message: "r",
    now: () => RESERVED_AT,
    apply: reserveStep({
      id: "gh-1-1",
      edition: EDITION,
      kind: "scheduled",
      config,
      at: RESERVED_AT,
    }),
  });
  // The research job crashed: no settlement. A fallback schedule does nothing.
  const later = new Date("2026-10-25T02:47:00.000Z");
  const plan = planResearch({
    now: later,
    event: "schedule",
    ref: "refs/heads/main",
    automation: "enabled",
    policy: APPROVED,
    ledgerState: remoteState(remote, later),
    publishedEdition: null,
  });
  assert.equal(plan.code, "ALREADY_DONE");
  // Manual recovery without naming the crashed run is refused; naming it works and counts both.
  const recover = (supersedes) =>
    ledgerTransaction({
      dir,
      message: "r",
      now: () => later,
      apply: reserveStep({
        id: "gh-2-1",
        edition: EDITION,
        kind: "manual",
        supersedes,
        config,
        at: later,
      }),
    });
  assert.equal(await codeOf(() => recover(null)), "ACTIVE_RESERVATION");
  const recovered = recover("gh-1-1");
  assert.equal(recovered.monthSpentUsd, 0.536 + 0.75);
  // Settling the crashed reservation from its report later is still possible.
  const state = remoteState(remote, later);
  assert.equal(state.reservations.get("gh-1-1").supersededBy, "gh-2-1");
  // A run without an edition settles without a handoff; a handoff is refused for it.
  const noEdition = {
    ...productionResult(EDITION, later, "run-2b3c4d5e").report,
    status: "no-edition",
  };
  assert.equal(
    await codeOf(() =>
      ledgerTransaction({
        dir,
        message: "s",
        now: () => later,
        apply: settleStep({
          id: "gh-2-1",
          summary: settlementSummary(noEdition),
          handoff: {
            workflowRunId: 2,
            runAttempt: 1,
            artifactId: 7,
            bundleDigest: "a".repeat(64),
          },
          at: later,
        }),
      }),
    ),
    "HANDOFF_REFUSED",
  );
  assert.equal(
    ledgerTransaction({
      dir,
      message: "s",
      now: () => later,
      apply: settleStep({
        id: "gh-2-1",
        summary: settlementSummary(noEdition),
        at: later,
      }),
    }).pushed,
    true,
  );
});

// --- Saturday -> Sunday --------------------------------------------------------------------

test("end to end: Saturday reserve, seal and settle; Sunday resolve, verify, decrypt, prepare, commit and push", async () => {
  const ledger = ledgerRemote();
  const { sealed } = saturday(ledger.clone("work"));
  const site = siteRemote();
  assert.equal(
    planPublication({
      now: SUNDAY,
      event: "schedule",
      ref: "refs/heads/main",
      automation: "enabled",
      policy: APPROVED,
      publishedEdition: null,
    }).run,
    "production",
  );
  const outcome = await sunday({
    remote: ledger.remote,
    content: site.content,
    bytes: sealed.bytes,
  });
  assert.deepEqual(
    [
      outcome.status,
      outcome.edition,
      outcome.dropped.length,
      outcome.reservationId,
    ],
    ["prepared", EDITION, 0, "gh-9100000001-1"],
  );
  const files = checkPublicationChanges(
    git(site.dir, "status", "--porcelain", "--untracked-files=all"),
    { edition: EDITION },
  );
  assert.deepEqual(files.sort(), [
    "src/content/tech-brief/editions/2026-10-24.json",
    "src/content/tech-brief/latest.json",
  ]);
  git(site.dir, "add", "--", ...files);
  git(site.dir, ...ME, "commit", "-q", "-m", `Publish Tech Brief ${EDITION}`);
  git(site.dir, "push", "-q", "origin", "HEAD:main");
  const published = execFileSync(
    "git",
    [
      "--git-dir",
      site.remote,
      "show",
      "main:src/content/tech-brief/latest.json",
    ],
    { encoding: "utf8" },
  );
  const edition = JSON.parse(published);
  assert.equal(edition.edition, EDITION);
  assert.equal(edition.stories.length, 3);
  // Nothing private reaches the public files.
  for (const secret of [
    "evidence",
    "quote",
    "runId",
    "generation",
    "run-1a2b3c4d",
    "Synthetic rehearsal claim",
  ])
    assert.ok(!published.includes(secret), secret);
  // A second trigger finds the edition published and changes nothing.
  assert.equal(
    planPublication({
      now: SUNDAY,
      event: "schedule",
      ref: "refs/heads/main",
      automation: "enabled",
      policy: APPROVED,
      publishedEdition: EDITION,
    }).code,
    "ALREADY_PUBLISHED",
  );
  const again = await sunday({
    remote: ledger.remote,
    content: site.content,
    bytes: sealed.bytes,
  });
  assert.equal(again.status, "already-published");
  assert.equal(
    await codeOf(() =>
      checkPublicationChanges(git(site.dir, "status", "--porcelain"), {
        edition: EDITION,
      }),
    ),
    "NOTHING_TO_PUBLISH",
  );
});

test("Sunday refuses tampered, expired, failed, mis-keyed or unregistered artifacts and leaves the content unchanged", async () => {
  const ledger = ledgerRemote();
  const { sealed } = saturday(ledger.clone("work"));
  const site = siteRemote();
  const latest = () => readFileSync(join(site.content, "latest.json"), "utf8");
  const before = latest();
  const flipped = Buffer.from(sealed.bytes);
  flipped[flipped.length - 5] ^= 1;
  const cases = [
    ["tampered bundle", { bytes: flipped }, "DIGEST_MISMATCH"],
    [
      "truncated bundle",
      { bytes: sealed.bytes.subarray(0, 100) },
      "DIGEST_MISMATCH",
    ],
    [
      "expired artifact",
      { recs: records({ artifact: { expired: true } }) },
      "ARTIFACT_EXPIRED",
    ],
    [
      "artifact expiring within the margin",
      {
        recs: records({
          artifact: {
            expires_at: new Date(SUNDAY.getTime() + 10 * 60_000).toISOString(),
          },
        }),
      },
      "ARTIFACT_EXPIRED",
    ],
    [
      "another artifact",
      { recs: records({ artifactId: 4100000002 }) },
      "ARTIFACT_MISMATCH",
    ],
    [
      "failed research run",
      { recs: records({ run: { conclusion: "failure" } }) },
      "RUN_NOT_SUCCESSFUL",
    ],
    [
      "run from another workflow",
      { recs: records({ path: REHEARSAL_WORKFLOW_PATH }) },
      "UNTRUSTED_RUN",
    ],
    [
      "run from a fork",
      {
        recs: records({
          run: {
            head_repository: { id: 999, full_name: "fork/ourfaces-site" },
          },
        }),
      },
      "UNTRUSTED_RUN",
    ],
    [
      "commit not on main",
      {
        recs: records({
          run: { head_sha: "f".repeat(40) },
          artifact: {
            workflow_run: {
              id: 9100000001,
              repository_id: 123456,
              head_repository_id: 123456,
              head_branch: "main",
              head_sha: "f".repeat(40),
            },
          },
        }),
      },
      "UNTRUSTED_COMMIT",
    ],
    ["wrong key", { keys: [OTHER_KEY] }, "KEY_MISMATCH"],
    ["the rehearsal key", { keys: [KEY, REHEARSAL_KEY] }, "REHEARSAL_KEY"],
    ["provisional policy", { policy: REAL_POLICY }, "POLICY_NOT_APPROVED"],
    [
      "no handoff for the edition",
      { edition: "2026-10-31", now: rehearsalClock("2026-10-31") },
      "NO_HANDOFF",
    ],
    [
      "outside the scheduled window",
      { now: new Date("2026-10-27T18:00:00.000Z") },
      "NOT_DUE",
    ],
  ];
  for (const [name, change, code] of cases) {
    const got = await codeOf(() =>
      sunday({
        remote: ledger.remote,
        content: site.content,
        bytes: sealed.bytes,
        ...change,
      }),
    );
    assert.equal(got, code, name);
    assert.equal(latest(), before, name);
    assert.equal(
      git(site.dir, "status", "--porcelain", "--untracked-files=all"),
      "",
      name,
    );
  }
});

test("Sunday refuses research results that cannot be published: provisional research, invalid editions", async () => {
  const site = siteRemote();
  const variants = {
    "provisional-policy research": (r) => {
      r.draft.generation = {
        ...r.draft.generation,
        policyStatus: "provisional",
        provisionalPolicyOverride: true,
      };
    },
    "two stories": (r) => {
      r.draft.stories = r.draft.stories.slice(0, 2);
      r.report.candidates = r.report.candidates.slice(0, 2);
      r.report.selected = r.report.selected.slice(0, 2);
    },
    "a story without a source page": (r) => {
      r.pages.delete(r.draft.stories[0].url);
    },
  };
  const outcomes = [];
  for (const [name, change] of Object.entries(variants)) {
    const ledger = ledgerRemote();
    const result = productionResult();
    change(result);
    let sealed;
    try {
      sealed = saturday(ledger.clone("work"), { result }).sealed;
    } catch (error) {
      outcomes.push(`${name}: sealing ${error.code}`);
      continue;
    }
    const fetcher = fixtureFetcher(result.pages);
    const got = await codeOf(() =>
      sundayPrepare({
        ledgerState: remoteState(ledger.remote),
        edition: EDITION,
        ...records(),
        expected: EXPECTED,
        isMainCommit: (s) => s === SHA,
        bundleBytes: sealed.bytes,
        keys: [KEY],
        policy: APPROVED,
        config,
        fetcher,
        contentDir: site.content,
        now: SUNDAY,
      }),
    );
    outcomes.push(`${name}: Sunday ${got}`);
    assert.equal(
      git(site.dir, "status", "--porcelain", "--untracked-files=all"),
      "",
      name,
    );
  }
  // Too few stories never even reaches an artifact; a source that no longer
  // verifies on Sunday drops its story, and fewer than three cannot publish.
  assert.deepEqual(outcomes, [
    "provisional-policy research: Sunday POLICY_NOT_APPROVED",
    "two stories: sealing INCONSISTENT",
    "a story without a source page: Sunday INSUFFICIENT_STORIES",
  ]);
});

test("a rejected push to main (another commit landed first) fails without force and leaves main as it was", async () => {
  const ledger = ledgerRemote();
  const { sealed } = saturday(ledger.clone("work"));
  const site = siteRemote();
  // Someone else pushes to main while Sunday prepares.
  const other = join(site.root, "other");
  execFileSync("git", ["clone", "-q", site.remote, other]);
  writeFileSync(join(other, "README.md"), "changed\n");
  git(other, ...ME, "commit", "-q", "-am", "other");
  git(other, "push", "-q", "origin", "HEAD:main");
  const remoteHead = git(other, "rev-parse", "HEAD");
  await sunday({
    remote: ledger.remote,
    content: site.content,
    bytes: sealed.bytes,
  });
  const files = checkPublicationChanges(
    git(site.dir, "status", "--porcelain", "--untracked-files=all"),
    { edition: EDITION },
  );
  git(site.dir, "add", "--", ...files);
  git(site.dir, ...ME, "commit", "-q", "-m", "publish");
  assert.throws(() => git(site.dir, "push", "-q", "origin", "HEAD:main"));
  assert.equal(
    execFileSync("git", ["--git-dir", site.remote, "rev-parse", "main"], {
      encoding: "utf8",
    }),
    remoteHead,
  );
});

test("checkPublicationChanges allows only this edition's two public files", async () => {
  const opts = { edition: EDITION };
  const ok =
    " M src/content/tech-brief/latest.json\n?? src/content/tech-brief/editions/2026-10-24.json\n";
  assert.equal(checkPublicationChanges(ok, opts).length, 2);
  assert.equal(
    checkPublicationChanges(" M src/content/tech-brief/latest.json\n", opts)
      .length,
    1,
  );
  for (const [porcelain, code] of [
    ["", "NOTHING_TO_PUBLISH"],
    [
      "?? src/content/tech-brief/editions/2026-10-24.json\n",
      "NOTHING_TO_PUBLISH",
    ],
    [
      `${ok}?? src/content/tech-brief/editions/2026-10-17.json\n`,
      "UNEXPECTED_CHANGES",
    ],
    [`${ok} M scripts/tech-brief/sources.json\n`, "UNEXPECTED_CHANGES"],
    [`${ok}?? research/report.json\n`, "UNEXPECTED_CHANGES"],
    [
      "R  src/content/tech-brief/a.json -> src/content/tech-brief/latest.json\n",
      "UNEXPECTED_CHANGES",
    ],
    [
      " D src/content/tech-brief/editions/2026-10-17.json\n M src/content/tech-brief/latest.json\n",
      "UNEXPECTED_CHANGES",
    ],
  ])
    assert.equal(
      await codeOf(() => checkPublicationChanges(porcelain, opts)),
      code,
      porcelain,
    );
});

// --- Helpers -------------------------------------------------------------------------------

test("gitIsAncestor, keysFromEnvironment and singleFile fail closed", async () => {
  const site = siteRemote();
  const head = git(site.dir, "rev-parse", "HEAD").trim();
  assert.equal(gitIsAncestor(head, "HEAD", { dir: site.dir }), true);
  assert.equal(gitIsAncestor("not-a-sha", "HEAD", { dir: site.dir }), false);
  assert.equal(
    gitIsAncestor(head.toUpperCase(), "HEAD", { dir: site.dir }),
    false,
  );
  git(site.dir, "checkout", "-q", "-b", "side");
  writeFileSync(join(site.dir, "README.md"), "side\n");
  git(site.dir, ...ME, "commit", "-q", "-am", "side");
  const side = git(site.dir, "rev-parse", "HEAD").trim();
  assert.equal(gitIsAncestor(side, "main", { dir: site.dir }), false);
  const b64 = (k) => k.toString("base64");
  assert.equal(
    keysFromEnvironment({ TECH_BRIEF_ARTIFACT_KEY: b64(KEY) }).length,
    1,
  );
  assert.equal(
    keysFromEnvironment({
      TECH_BRIEF_ARTIFACT_KEY: b64(KEY),
      TECH_BRIEF_ARTIFACT_KEY_PREVIOUS: b64(OTHER_KEY),
    }).length,
    2,
  );
  assert.notEqual(await codeOf(() => keysFromEnvironment({})), "NO_ERROR");
  assert.notEqual(
    await codeOf(() =>
      keysFromEnvironment({ TECH_BRIEF_ARTIFACT_KEY: "short" }),
    ),
    "NO_ERROR",
  );
  assert.equal(
    await codeOf(() =>
      keysFromEnvironment({ TECH_BRIEF_ARTIFACT_KEY: b64(REHEARSAL_KEY) }),
    ),
    "REHEARSAL_KEY",
  );
  assert.equal(
    await codeOf(() =>
      keysFromEnvironment({
        TECH_BRIEF_ARTIFACT_KEY: b64(KEY),
        TECH_BRIEF_ARTIFACT_KEY_PREVIOUS: b64(REHEARSAL_KEY),
      }),
    ),
    "REHEARSAL_KEY",
  );
  const dir = temp("artifact");
  assert.equal(await codeOf(() => singleFile(dir)), "ARTIFACT_CONTENT");
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "nested", "research-bundle.bin"), "x");
  assert.equal(singleFile(dir), join(dir, "nested", "research-bundle.bin"));
  writeFileSync(join(dir, "extra.bin"), "y");
  assert.equal(await codeOf(() => singleFile(dir)), "ARTIFACT_CONTENT");
});

test("verifyLive waits for both Insights pages to show the edition, then gives up", async () => {
  const page = (shown) => ({
    ok: true,
    text: async () =>
      shown ? `<section data-edition="${EDITION}">` : "<section>",
  });
  const seen = [];
  let calls = 0;
  const later = async (url) => {
    seen.push(new URL(url).pathname);
    calls++;
    return page(calls > 3);
  };
  const ok = await verifyLive({
    edition: EDITION,
    fetchImpl: later,
    sleep: async () => {},
    attempts: 5,
  });
  assert.deepEqual([ok.ok, ok.attempt], [true, 3]);
  assert.deepEqual([...new Set(seen)].sort(), ["/fr/insights", "/insights"]);
  const enOnly = async (url) => page(new URL(url).pathname === "/insights");
  assert.equal(
    await codeOf(() =>
      verifyLive({
        edition: EDITION,
        fetchImpl: enOnly,
        sleep: async () => {},
        attempts: 3,
      }),
    ),
    "LIVE_NOT_UPDATED",
  );
  const failing = async () => {
    throw new Error("network");
  };
  assert.equal(
    await codeOf(() =>
      verifyLive({
        edition: EDITION,
        fetchImpl: failing,
        sleep: async () => {},
        attempts: 2,
      }),
    ),
    "LIVE_NOT_UPDATED",
  );
  const error = async () => ({
    ok: false,
    text: async () => `data-edition="${EDITION}"`,
  });
  assert.equal(
    await codeOf(() =>
      verifyLive({
        edition: EDITION,
        fetchImpl: error,
        sleep: async () => {},
        attempts: 2,
      }),
    ),
    "LIVE_NOT_UPDATED",
  );
});

// --- Rehearsal -----------------------------------------------------------------------------

test("rehearsal: verifies the plumbing with synthetic content and never writes; production refuses its bundles", async () => {
  const edition = EDITION;
  const { report, draft } = rehearsalResult(edition);
  const expected = {
    repository: "owner/ourfaces-site",
    repositoryId: 123456,
    workflowPath: REHEARSAL_WORKFLOW_PATH,
    branch: "main",
    events: ["workflow_dispatch"],
  };
  const sealed = sealBundle({
    report,
    draft,
    workflow: workflowRefOf(expected),
    key: REHEARSAL_KEY,
  });
  const handoff = {
    reservationId: "rehearsal",
    edition,
    kind: "manual",
    researchRunId: REHEARSAL_RUN_ID,
    workflowRunId: 77,
    runAttempt: 1,
    artifactId: 88,
    bundleDigest: sealed.digest,
  };
  const recs = records({
    runId: 77,
    artifactId: 88,
    path: REHEARSAL_WORKFLOW_PATH,
    run: { event: "workflow_dispatch" },
  });
  const site = siteRemote();
  const outcome = await rehearseSunday({
    handoff,
    ...recs,
    expected,
    isMainCommit: (s) => s === SHA,
    bundleBytes: sealed.bytes,
    contentDir: site.content,
    now: SUNDAY,
  });
  assert.deepEqual(
    [outcome.status, outcome.edition, outcome.dropped.length],
    ["checked", edition, 0],
  );
  assert.equal(
    git(site.dir, "status", "--porcelain", "--untracked-files=all"),
    "",
  );
  // The rehearsal bundle cannot pass for production: wrong workflow, and its key is refused.
  const ledger = ledgerRemote();
  saturday(ledger.clone("work"));
  assert.equal(
    await codeOf(() =>
      sunday({
        remote: ledger.remote,
        content: site.content,
        bytes: sealed.bytes,
        keys: [REHEARSAL_KEY],
      }),
    ),
    "REHEARSAL_KEY",
  );
  assert.notEqual(
    await codeOf(() =>
      sunday({
        remote: ledger.remote,
        content: site.content,
        bytes: sealed.bytes,
      }),
    ),
    "NO_ERROR",
  );
});

// --- CLI -----------------------------------------------------------------------------------

test("CLI: disabled or non-main runs plan nothing; manual refusals are visible; outputs carry no content", () => {
  const out = temp("cli");
  const outputs = join(out, "github-output");
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(GITHUB_|TECH_BRIEF_|OPENAI_)/.test(k),
    ),
  );
  const run = (script, args, env) =>
    spawnSync(process.execPath, [script, ...args], {
      env: { ...clean, GITHUB_OUTPUT: outputs, ...env },
      encoding: "utf8",
    });
  const args = ["plan-publication", "--content-dir", CONTENT];
  const scheduled = run(AUTOMATION, args, {
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_REF: "refs/heads/main",
  });
  assert.equal(scheduled.status, 0);
  assert.equal(JSON.parse(scheduled.stdout).run, "skip");
  assert.match(readFileSync(outputs, "utf8"), /^run=skip$/m);
  const manual = run(AUTOMATION, args, {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    TECH_BRIEF_AUTOMATION: "enabled",
  });
  // The real policy is provisional, so even an enabled manual run is refused.
  assert.equal(manual.status, 4);
  assert.match(JSON.parse(manual.stdout).reason, /provisional|not approved/);
  // Manual mode: a schedule is a quiet skip; a dispatch passes activation and
  // is then refused only by the provisional policy.
  const env = (event, automation) => ({
    GITHUB_EVENT_NAME: event,
    GITHUB_REF: "refs/heads/main",
    TECH_BRIEF_AUTOMATION: automation,
  });
  const manualSchedule = run(AUTOMATION, args, env("schedule", "manual"));
  assert.deepEqual(
    [manualSchedule.status, JSON.parse(manualSchedule.stdout).run],
    [0, "skip"],
  );
  assert.match(
    JSON.parse(manualSchedule.stdout).reason,
    /Scheduled runs are off/,
  );
  const manualDispatch = run(
    AUTOMATION,
    args,
    env("workflow_dispatch", "manual"),
  );
  assert.equal(manualDispatch.status, 4);
  assert.match(
    JSON.parse(manualDispatch.stdout).reason,
    /provisional|not approved/,
  );
  const off = run(AUTOMATION, args, env("workflow_dispatch", "off"));
  assert.equal(off.status, 4);
  assert.match(JSON.parse(off.stdout).reason, /Automation is off/);
  const research = run(
    AUTOMATION,
    ["plan-research", "--content-dir", CONTENT, "--ledger-dir", out],
    {
      GITHUB_EVENT_NAME: "schedule",
      GITHUB_REF: "refs/heads/feature",
      TECH_BRIEF_AUTOMATION: "enabled",
    },
  );
  assert.deepEqual(
    [research.status, JSON.parse(research.stdout).run],
    [0, "skip"],
  );
  assert.equal(run(AUTOMATION, ["nope"], {}).status, 1);
  // Errors print a code and a short message only.
  const resolve = run(
    AUTOMATION,
    ["resolve", "--ledger-dir", out, "--edition", EDITION],
    {},
  );
  assert.deepEqual(
    [resolve.status, JSON.parse(resolve.stdout).code],
    [4, "LEDGER_MISSING"],
  );
  const seal = run(
    AUTOMATION,
    ["seal", "--research-dir", out, "--out-dir", join(out, "b")],
    { TECH_BRIEF_ARTIFACT_KEY: REHEARSAL_KEY.toString("base64") },
  );
  assert.deepEqual(
    [seal.status, JSON.parse(seal.stdout).code],
    [4, "REHEARSAL_KEY"],
  );
  // research-outputs with no report: the job fails (alert), settlement is
  // skipped (empty summary) and the reservation stays counted.
  const missing = run(
    AUTOMATION,
    ["research-outputs", "--out", join(out, "none")],
    {},
  );
  assert.equal(missing.status, 4);
  assert.deepEqual(JSON.parse(missing.stdout), {
    status: "missing",
    summary: "",
  });
  assert.match(readFileSync(outputs, "utf8"), /^summary=$/m);
});

test("CLI: rehearsal seal writes only an encrypted bundle and identifiers", () => {
  const out = temp("rehearsal-cli");
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(GITHUB_|TECH_BRIEF_|OPENAI_)/.test(k),
    ),
  );
  const result = spawnSync(
    process.execPath,
    [REHEARSAL, "seal", "--out-dir", out],
    {
      env: {
        ...clean,
        GITHUB_RUN_ID: "77",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW_REF: `owner/ourfaces-site/${REHEARSAL_WORKFLOW_PATH}@refs/heads/main`,
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stdout);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).sort(), [
    "artifact_name",
    "bundle_digest",
    "edition",
    "path",
  ]);
  assert.deepEqual(readdirSync(out), ["rehearsal-bundle.bin"]);
  const bytes = readFileSync(join(out, "rehearsal-bundle.bin"));
  for (const plain of [
    "Synthetic rehearsal claim",
    "rehearsal-alpha",
    "sourceHeadline",
  ])
    assert.ok(!bytes.includes(plain), plain);
});
