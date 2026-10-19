// Phase 4 artifact provenance and the offline end-to-end handoff:
// reserve -> seal -> settle and register -> resolve -> verify provenance ->
// decrypt, with tampering at every boundary. GitHub records are synthetic and
// shaped like the REST API's artifact and workflow run attempt objects.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BundleError, sealBundle } from "../bundle.mjs";
import {
  LedgerError,
  initLedger,
  readLedger,
  reserve,
  settleAndRegister,
  settlementSummary,
} from "../ledger.mjs";
import {
  EXPIRY_MARGIN_MS,
  ProvenanceError,
  bundleArtifactName,
  openVerifiedBundle,
  resolveHandoff,
  verifyProvenance,
  workflowRefOf,
} from "../provenance.mjs";
import { loadConfig } from "../research.mjs";
import { fixtureJson } from "./helpers.mjs";

const config = await loadConfig();
const T = (iso) => new Date(iso);
const KEY = createHash("sha256")
  .update("ourfaces test-only bundle key A")
  .digest();
const OTHER_KEY = createHash("sha256")
  .update("ourfaces test-only bundle key B")
  .digest();
const EXPECTED = Object.freeze({
  repository: "owner/ourfaces-site",
  repositoryId: 123456,
  workflowPath: ".github/workflows/tech-brief-research.yml",
  branch: "main",
  events: ["schedule", "workflow_dispatch"],
});
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const isMainCommit = (sha) => sha === SHA;
const NOW = T("2026-10-26T00:10:00.000Z"); // Sunday 20:10 EDT
const HANDOFF = Object.freeze({
  reservationId: "gh-9100000001-1",
  edition: "2026-10-24",
  kind: "scheduled",
  researchRunId: "run-1a2b3c4d",
  workflowRunId: 9100000001,
  runAttempt: 1,
  artifactId: 4100000001,
  bundleDigest: "a".repeat(64),
  registeredAt: "2026-10-25T00:40:00.000Z",
});
// Synthetic API records; extra fields as the API returns them are allowed.
const artifactFor = (h = HANDOFF, overrides = {}) => ({
  id: h.artifactId,
  node_id: "MDg6QXJ0aWZhY3Q=",
  name: bundleArtifactName(h.edition, h.workflowRunId, h.runAttempt),
  size_in_bytes: 21000,
  url: "https://api.github.invalid/artifact",
  archive_download_url: "https://api.github.invalid/artifact/zip",
  expired: false,
  created_at: "2026-10-25T00:39:00Z",
  updated_at: "2026-10-25T00:39:00Z",
  expires_at: "2027-01-23T00:39:00Z",
  digest: "sha256:" + "c".repeat(64),
  workflow_run: {
    id: h.workflowRunId,
    repository_id: 123456,
    head_repository_id: 123456,
    head_branch: "main",
    head_sha: SHA,
  },
  ...overrides,
});
const runFor = (h = HANDOFF, overrides = {}) => ({
  id: h.workflowRunId,
  name: "Tech Brief research",
  run_attempt: h.runAttempt,
  path: ".github/workflows/tech-brief-research.yml",
  event: "schedule",
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  head_sha: SHA,
  repository: { id: 123456, full_name: "owner/ourfaces-site" },
  head_repository: { id: 123456, full_name: "owner/ourfaces-site" },
  ...overrides,
});
const verify = (overrides = {}) =>
  verifyProvenance({
    handoff: HANDOFF,
    artifact: artifactFor(),
    run: runFor(),
    expected: EXPECTED,
    isMainCommit,
    now: NOW,
    ...overrides,
  });
const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    if (
      error instanceof ProvenanceError ||
      error instanceof BundleError ||
      error instanceof LedgerError
    )
      return error.code;
    throw error;
  }
  return "NO_ERROR";
};

test("valid provenance yields the bundle digest and the identity bundle.mjs must enforce", () => {
  const verified = verify();
  assert.deepEqual(verified, {
    edition: "2026-10-24",
    reservationId: "gh-9100000001-1",
    artifactId: 4100000001,
    artifactName: "tech-brief-bundle-2026-10-24-9100000001-1",
    workflowRunId: 9100000001,
    runAttempt: 1,
    bundle: {
      digest: "a".repeat(64),
      expected: {
        edition: "2026-10-24",
        runId: "run-1a2b3c4d",
        workflow:
          "owner/ourfaces-site/.github/workflows/tech-brief-research.yml@refs/heads/main",
        mode: "production",
      },
    },
  });
  assert.equal(workflowRefOf(EXPECTED), verified.bundle.expected.workflow);
  assert.equal(
    verify({ run: runFor(HANDOFF, { event: "workflow_dispatch" }) }).artifactId,
    4100000001,
  );
});

test("the artifact must be the registered one, from this repository, branch and run", () => {
  const wr = (change) => ({ ...artifactFor().workflow_run, ...change });
  const cases = [
    ["another artifact id", { id: 4100000002 }, "ARTIFACT_MISMATCH"],
    [
      "name of another attempt",
      { name: bundleArtifactName("2026-10-24", 9100000001, 2) },
      "ARTIFACT_MISMATCH",
    ],
    [
      "name of another edition",
      { name: bundleArtifactName("2026-10-17", 9100000001, 1) },
      "ARTIFACT_MISMATCH",
    ],
    [
      "another workflow run",
      { workflow_run: wr({ id: 9100000002 }) },
      "ARTIFACT_MISMATCH",
    ],
    [
      "another repository",
      { workflow_run: wr({ repository_id: 999 }) },
      "UNTRUSTED_RUN",
    ],
    [
      "a fork",
      { workflow_run: wr({ head_repository_id: 999 }) },
      "UNTRUSTED_RUN",
    ],
    [
      "another branch",
      { workflow_run: wr({ head_branch: "feature" }) },
      "UNTRUSTED_RUN",
    ],
    [
      "another commit than the run",
      { workflow_run: wr({ head_sha: OTHER_SHA }) },
      "ARTIFACT_MISMATCH",
    ],
    ["empty", { size_in_bytes: 0 }, "ARTIFACT_MISMATCH"],
    ["too large", { size_in_bytes: 50 * 1024 * 1024 }, "ARTIFACT_MISMATCH"],
  ];
  for (const [name, overrides, code] of cases)
    assert.equal(
      codeOf(() => verify({ artifact: artifactFor(HANDOFF, overrides) })),
      code,
      name,
    );
});

test("expired, nearly expired or future-dated artifacts are refused", () => {
  assert.equal(
    codeOf(() => verify({ artifact: artifactFor(HANDOFF, { expired: true }) })),
    "ARTIFACT_EXPIRED",
  );
  assert.equal(
    codeOf(() =>
      verify({
        artifact: artifactFor(HANDOFF, { expires_at: "2026-10-25T00:00:00Z" }),
      }),
    ),
    "ARTIFACT_EXPIRED",
  );
  const soon = new Date(NOW.getTime() + EXPIRY_MARGIN_MS / 2).toISOString();
  assert.equal(
    codeOf(() =>
      verify({ artifact: artifactFor(HANDOFF, { expires_at: soon }) }),
    ),
    "ARTIFACT_EXPIRED",
  );
  assert.equal(
    codeOf(() =>
      verify({
        artifact: artifactFor(HANDOFF, { created_at: "2026-10-27T00:00:00Z" }),
      }),
    ),
    "INVALID_METADATA",
  );
});

test("the run must be that exact attempt of the research workflow on main, scheduled or dispatched, and successful", () => {
  const cases = [
    ["another run", { id: 9100000002 }, "RUN_MISMATCH"],
    ["a re-run attempt's record", { run_attempt: 2 }, "RUN_MISMATCH"],
    [
      "another repository id",
      { repository: { id: 999, full_name: "owner/ourfaces-site" } },
      "UNTRUSTED_RUN",
    ],
    [
      "another repository name",
      { repository: { id: 123456, full_name: "someone/ourfaces-site" } },
      "UNTRUSTED_RUN",
    ],
    [
      "a fork's head",
      { head_repository: { id: 999, full_name: "someone/ourfaces-site" } },
      "UNTRUSTED_RUN",
    ],
    [
      "another workflow",
      { path: ".github/workflows/other.yml" },
      "UNTRUSTED_RUN",
    ],
    ["another branch", { head_branch: "feature" }, "UNTRUSTED_RUN"],
    ["push", { event: "push" }, "UNTRUSTED_RUN"],
    ["pull_request", { event: "pull_request" }, "UNTRUSTED_RUN"],
    ["pull_request_target", { event: "pull_request_target" }, "UNTRUSTED_RUN"],
    ["workflow_run", { event: "workflow_run" }, "UNTRUSTED_RUN"],
    [
      "in progress",
      { status: "in_progress", conclusion: null },
      "RUN_NOT_SUCCESSFUL",
    ],
    ["failed", { conclusion: "failure" }, "RUN_NOT_SUCCESSFUL"],
    ["cancelled", { conclusion: "cancelled" }, "RUN_NOT_SUCCESSFUL"],
    ["skipped", { conclusion: "skipped" }, "RUN_NOT_SUCCESSFUL"],
  ];
  for (const [name, overrides, code] of cases)
    assert.equal(
      codeOf(() => verify({ run: runFor(HANDOFF, overrides) })),
      code,
      name,
    );
  // Only scheduled runs, when that is all the configuration allows.
  assert.equal(
    codeOf(() =>
      verify({
        expected: { ...EXPECTED, events: ["schedule"] },
        run: runFor(HANDOFF, { event: "workflow_dispatch" }),
      }),
    ),
    "UNTRUSTED_RUN",
  );
});

test("a commit is trusted only when the caller confirms it is on main", () => {
  assert.equal(
    codeOf(() => verify({ isMainCommit: () => false })),
    "UNTRUSTED_COMMIT",
  );
  assert.equal(
    codeOf(() => verify({ isMainCommit: () => "yes" })),
    "UNTRUSTED_COMMIT",
  );
  assert.equal(
    codeOf(() => verify({ isMainCommit: undefined })),
    "INVALID_EXPECTATION",
  );
  const both = (sha) => ({
    artifact: artifactFor(HANDOFF, {
      workflow_run: { ...artifactFor().workflow_run, head_sha: sha },
    }),
    run: runFor(HANDOFF, { head_sha: sha }),
  });
  assert.equal(
    codeOf(() => verify(both(OTHER_SHA))),
    "UNTRUSTED_COMMIT",
    "consistent records, but not on main",
  );
  assert.throws(
    () =>
      verify({
        isMainCommit: () => {
          throw new Error("git failed");
        },
      }),
    /git failed/,
  );
});

test("records with missing or mistyped fields, and invalid expectations, are refused", () => {
  const artifactCases = {
    "not an object": null,
    "no workflow_run": artifactFor(HANDOFF, { workflow_run: null }),
    "string id": artifactFor(HANDOFF, { id: "4100000001" }),
    "no expiry": artifactFor(HANDOFF, { expires_at: null }),
    "no creation time": artifactFor(HANDOFF, { created_at: null }),
    "expired as string": artifactFor(HANDOFF, { expired: "false" }),
    "short sha": artifactFor(HANDOFF, {
      workflow_run: { ...artifactFor().workflow_run, head_sha: "abc" },
    }),
  };
  for (const [name, artifact] of Object.entries(artifactCases))
    assert.equal(
      codeOf(() => verify({ artifact })),
      "INVALID_METADATA",
      name,
    );
  const runCases = {
    "not an object": [],
    "no repository": runFor(HANDOFF, { repository: null }),
    "attempt 0": runFor(HANDOFF, { run_attempt: 0 }),
    "no path": runFor(HANDOFF, { path: undefined }),
    "numeric conclusion": runFor(HANDOFF, { conclusion: 1 }),
    "uppercase sha": runFor(HANDOFF, { head_sha: SHA.toUpperCase() }),
  };
  for (const [name, run] of Object.entries(runCases))
    assert.equal(
      codeOf(() => verify({ run })),
      "INVALID_METADATA",
      name,
    );
  for (const change of [
    { repositoryId: "123456" },
    { repository: "ourfaces-site" },
    { workflowPath: "scripts/research.yml" },
    { branch: "" },
    { events: ["push"] },
    { events: [] },
  ])
    assert.equal(
      codeOf(() => verify({ expected: { ...EXPECTED, ...change } })),
      "INVALID_EXPECTATION",
      JSON.stringify(change),
    );
  assert.equal(
    codeOf(() => verify({ handoff: null })),
    "NO_HANDOFF",
  );
  assert.equal(
    codeOf(() => openVerifiedBundle(Buffer.alloc(10), null, [KEY])),
    "NO_HANDOFF",
  );
});

// --- Offline end-to-end ----------------------------------------------------------------

/** A synthetic successful research result (report and draft) for one run. */
function researchResult({
  runId = "run-1a2b3c4d",
  mode = "production",
  startedAt = "2026-10-25T00:20:00.000Z",
} = {}) {
  const draft = fixtureJson("valid-edition.json");
  draft.generation = {
    runId,
    mode,
    policyStatus: "approved",
    provisionalPolicyOverride: false,
    models: {},
    estimatedCostUsd: 0.191048,
  };
  const report = {
    schema: "ourfaces-tech-brief-research-report/1",
    runId,
    mode,
    edition: draft.edition,
    status: "edition",
    startedAt,
    finishedAt: new Date(Date.parse(startedAt) + 4 * 60_000).toISOString(),
    candidates: draft.stories.map((s, i) => ({
      key: `k${i + 1}`,
      url: s.url,
      status: "selected",
      storyId: s.id,
    })),
    selected: draft.stories.map((s, i) => `k${i + 1}`),
    validation: { ok: true, errors: [], warnings: [] },
    budget: { runTotalCountedUsd: 0.191048 },
  };
  return { report, draft };
}

/** Saturday: reserve, research (synthetic), seal, upload (simulated id), settle and register. */
function saturday({
  attempt = 1,
  workflowRunId = 9100000001,
  artifactId = 4100000001,
  supersedes = null,
  path,
  sealWith = {},
} = {}) {
  const ledger =
    path ??
    join(mkdtempSync(join(tmpdir(), "tb-handoff-")), "tech-brief-ledger.jsonl");
  if (!path) initLedger(ledger, { at: T("2026-09-20T00:00:00.000Z") });
  const reservationId = `gh-${workflowRunId}-${attempt}`;
  const reservedAt = new Date(
    Date.parse("2026-10-25T00:17:00.000Z") + (attempt - 1) * 3_600_000,
  );
  reserve(ledger, {
    id: reservationId,
    edition: "2026-10-24",
    kind: "scheduled",
    supersedes,
    at: reservedAt,
    config,
  });
  const result = researchResult({
    startedAt: new Date(reservedAt.getTime() + 3 * 60_000).toISOString(),
    ...sealWith.result,
  });
  const sealed = sealBundle({
    ...result,
    workflow: sealWith.workflow ?? workflowRefOf(EXPECTED),
    key: sealWith.key ?? KEY,
  });
  settleAndRegister(ledger, {
    id: reservationId,
    report: settlementSummary(result.report),
    handoff: {
      workflowRunId,
      runAttempt: attempt,
      artifactId,
      bundleDigest: sealed.digest,
    },
    at: new Date(reservedAt.getTime() + 20 * 60_000),
  });
  return { ledger, sealed, result, reservationId };
}

/** Sunday: resolve, verify provenance, open. Throws on any failure. */
function sunday(
  ledger,
  bytes,
  {
    records = (h) => ({ artifact: artifactFor(h), run: runFor(h) }),
    keys = [KEY],
    edition = "2026-10-24",
  } = {},
) {
  const state = readLedger(ledger, { now: NOW }).state;
  const handoff = resolveHandoff(state, edition);
  const verified = verifyProvenance({
    handoff,
    ...records(handoff),
    expected: EXPECTED,
    isMainCommit,
    now: NOW,
  });
  return {
    handoff,
    verified,
    opened: openVerifiedBundle(bytes, verified, keys),
  };
}

test("end to end: reserve, seal, settle and register, resolve, verify provenance, decrypt", () => {
  const { ledger, sealed, result } = saturday();
  const { handoff, verified, opened } = sunday(ledger, sealed.bytes);
  assert.deepEqual(
    [handoff.researchRunId, handoff.artifactId, handoff.bundleDigest],
    ["run-1a2b3c4d", 4100000001, sealed.digest],
  );
  assert.equal(
    verified.artifactName,
    "tech-brief-bundle-2026-10-24-9100000001-1",
  );
  assert.deepEqual(opened.draft, result.draft);
  assert.deepEqual(opened.report, result.report);
});

test("end to end: tampering at every boundary stops before any content is returned", () => {
  const { ledger, sealed } = saturday();
  const other = sealBundle({
    ...researchResult({ runId: "run-ffffffff" }),
    workflow: workflowRefOf(EXPECTED),
    key: KEY,
  });
  const flipped = Buffer.from(sealed.bytes);
  flipped[flipped.length - 20] ^= 1;
  const cases = {
    "no handoff for the edition": () =>
      sunday(ledger, sealed.bytes, { edition: "2026-10-31" }),
    "artifact record of another run": () =>
      sunday(ledger, sealed.bytes, {
        records: (h) => ({
          artifact: artifactFor({ ...h, workflowRunId: 9100000002 }),
          run: runFor(h),
        }),
      }),
    "expired artifact": () =>
      sunday(ledger, sealed.bytes, {
        records: (h) => ({
          artifact: artifactFor(h, { expired: true }),
          run: runFor(h),
        }),
      }),
    "failed run": () =>
      sunday(ledger, sealed.bytes, {
        records: (h) => ({
          artifact: artifactFor(h),
          run: runFor(h, { conclusion: "failure" }),
        }),
      }),
    "substituted genuine bundle of another run": () =>
      sunday(ledger, other.bytes),
    "modified download": () => sunday(ledger, flipped),
    "wrong key": () => sunday(ledger, sealed.bytes, { keys: [OTHER_KEY] }),
  };
  const codes = Object.fromEntries(
    Object.entries(cases).map(([name, fn]) => [name, codeOf(fn)]),
  );
  assert.deepEqual(codes, {
    "no handoff for the edition": "NO_HANDOFF",
    "artifact record of another run": "ARTIFACT_MISMATCH",
    "expired artifact": "ARTIFACT_EXPIRED",
    "failed run": "RUN_NOT_SUCCESSFUL",
    "substituted genuine bundle of another run": "DIGEST_MISMATCH",
    "modified download": "DIGEST_MISMATCH",
    "wrong key": "KEY_MISMATCH",
  });

  // A forged digest (someone rewrote the handoff) still cannot pass: the
  // research run id comes from the settlement and the bundle is bound to it.
  const state = readLedger(ledger, { now: NOW }).state;
  const verified = verifyProvenance({
    handoff: resolveHandoff(state, "2026-10-24"),
    artifact: artifactFor(),
    run: runFor(),
    expected: EXPECTED,
    isMainCommit,
    now: NOW,
  });
  const forged = {
    ...verified,
    bundle: { ...verified.bundle, digest: other.digest },
  };
  assert.equal(
    codeOf(() => openVerifiedBundle(other.bytes, forged, [KEY])),
    "RUN_MISMATCH",
  );

  // A corrupted ledger is refused before anything else happens.
  writeFileSync(ledger, `${readFileSync(ledger, "utf8")}garbage\n`);
  assert.equal(
    codeOf(() => sunday(ledger, sealed.bytes)),
    "LEDGER_CORRUPT",
  );
});

test("end to end: dry-run results and bundles sealed for another workflow ref are refused", () => {
  const dry = saturday({ sealWith: { result: { mode: "dry-run" } } });
  assert.equal(
    codeOf(() => sunday(dry.ledger, dry.sealed.bytes)),
    "MODE_MISMATCH",
  );
  const feature = saturday({
    sealWith: {
      workflow:
        "owner/ourfaces-site/.github/workflows/tech-brief-research.yml@refs/heads/feature",
    },
  });
  assert.equal(
    codeOf(() => sunday(feature.ledger, feature.sealed.bytes)),
    "WORKFLOW_MISMATCH",
  );
});

test("end to end: a re-run attempt is resolved with its own attempt's records; the crashed attempt stays counted", () => {
  const ledger = join(
    mkdtempSync(join(tmpdir(), "tb-handoff-")),
    "tech-brief-ledger.jsonl",
  );
  initLedger(ledger, { at: T("2026-09-20T00:00:00.000Z") });
  // Attempt 1 crashed after reserving (no settlement, no handoff).
  reserve(ledger, {
    id: "gh-9100000001-1",
    edition: "2026-10-24",
    kind: "scheduled",
    at: T("2026-10-25T00:17:00.000Z"),
    config,
  });
  assert.equal(
    codeOf(() => sunday(ledger, Buffer.alloc(0))),
    "NO_HANDOFF",
  );
  // Attempt 2 of the same run.
  const { sealed } = saturday({
    path: ledger,
    attempt: 2,
    artifactId: 4100000002,
    supersedes: "gh-9100000001-1",
  });
  const { handoff, opened } = sunday(ledger, sealed.bytes);
  assert.deepEqual(
    [handoff.reservationId, handoff.runAttempt],
    ["gh-9100000001-2", 2],
  );
  assert.equal(opened.draft.stories.length, 4);
  // Records of attempt 1, or an artifact named for attempt 1, do not verify attempt 2.
  assert.equal(
    codeOf(() =>
      sunday(ledger, sealed.bytes, {
        records: (h) => ({
          artifact: artifactFor(h),
          run: runFor({ ...h, runAttempt: 1 }),
        }),
      }),
    ),
    "RUN_MISMATCH",
  );
  assert.equal(
    codeOf(() =>
      sunday(ledger, sealed.bytes, {
        records: (h) => ({
          artifact: artifactFor(h, {
            name: bundleArtifactName(h.edition, h.workflowRunId, 1),
          }),
          run: runFor(h),
        }),
      }),
    ),
    "ARTIFACT_MISMATCH",
  );
  const unsettled = readLedger(ledger, { now: NOW }).state.reservations.get(
    "gh-9100000001-1",
  );
  assert.equal(
    unsettled.settlement,
    null,
    "the crashed attempt is not forgiven",
  );
});
