// Phase 4: provenance of a Saturday research artifact, checked on Sunday
// before it is downloaded and decrypted. Pure and offline: the future
// workflow fetches the GitHub records with limited permissions and passes
// them in; nothing here touches the network.
//
// Trust comes from three independent sources, none of which is the ledger's
// hash chain on its own:
// - The ledger handoff says which run the system settled and registered
//   (reservation, research run id, workflow run and attempt, artifact id,
//   bundle digest).
// - GitHub's own artifact and run-attempt records, which repository workflows
//   cannot write, say where the artifact really came from. Both are checked
//   against a fixed expectation: this repository (not a fork), the research
//   workflow file, the main branch, a scheduled or manually dispatched run,
//   that exact attempt, completed successfully.
// - The research commit is trusted only if the caller confirms it is on main
//   (isMainCommit, e.g. `git merge-base --is-ancestor <sha> origin/main` in a
//   checkout of this repository); a commit is not trusted because GitHub
//   reports it.
// The bundle itself is then authenticated by bundle.mjs (AES-256-GCM) with
// the digest and identity returned here.
//
// Re-runs: a workflow run id is shared by all its attempts and GitHub's
// artifact record does not name the attempt. The handoff therefore records
// the attempt, the artifact name must be the one derived from edition, run
// and attempt (artifact names are unique within a run and artifacts are
// immutable), and the run record checked is that attempt's own record
// (GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt}). A
// manual recovery is a new run with a new id.
//
// Secret separation for the workflows:
// - Saturday research job: OpenAI API key and the artifact key (seal).
// - Sunday verification job: the artifact key only (open), plus a token with
//   actions: read to fetch the records below and download the artifact.
// - Ledger reserve and settle jobs: neither key; write access to the ledger
//   branch only.

import { MAX_BUNDLE_BYTES, openBundle } from "./bundle.mjs";
import { findHandoff } from "./ledger.mjs";
import { isSaturdayDate } from "./schedule.mjs";

export class ProvenanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProvenanceError";
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new ProvenanceError(code, message);
};

// The artifact must stay available while it is downloaded and checked.
export const EXPIRY_MARGIN_MS = 60 * 60_000;
// The artifact is a zip around one bundle file.
const MAX_ARTIFACT_BYTES = MAX_BUNDLE_BYTES + 64 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_.-]{1,100}\.ya?ml$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
const ALLOWED_EVENTS = ["schedule", "workflow_dispatch"];

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isInstant = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** The artifact name the research job must use; it binds edition, run and attempt. */
export function bundleArtifactName(edition, workflowRunId, runAttempt) {
  return `tech-brief-bundle-${edition}-${workflowRunId}-${runAttempt}`;
}

/** The workflow identity sealed into the bundle (GitHub's GITHUB_WORKFLOW_REF form). */
export const workflowRefOf = (expected) =>
  `${expected.repository}/${expected.workflowPath}@refs/heads/${expected.branch}`;

function checkExpected(expected) {
  const bad = (field) =>
    fail("INVALID_EXPECTATION", `Expected ${field} is missing or invalid`);
  if (!isObject(expected)) bad("configuration");
  if (
    typeof expected.repository !== "string" ||
    !REPOSITORY.test(expected.repository)
  )
    bad("repository");
  if (!isId(expected.repositoryId)) bad("repositoryId");
  if (
    typeof expected.workflowPath !== "string" ||
    !WORKFLOW_PATH.test(expected.workflowPath)
  )
    bad("workflowPath");
  if (typeof expected.branch !== "string" || !BRANCH.test(expected.branch))
    bad("branch");
  if (
    !Array.isArray(expected.events) ||
    expected.events.length === 0 ||
    !expected.events.every((e) => ALLOWED_EVENTS.includes(e))
  )
    bad("events");
}

/** Strict shape of GitHub's artifact record (REST "Get an artifact"). */
function checkArtifactShape(a) {
  const bad = (field) => fail("INVALID_METADATA", `Artifact record: ${field}`);
  if (!isObject(a)) bad("not an object");
  if (!isId(a.id)) bad("id");
  if (typeof a.name !== "string") bad("name");
  if (!Number.isSafeInteger(a.size_in_bytes)) bad("size_in_bytes");
  if (typeof a.expired !== "boolean") bad("expired");
  if (!isInstant(a.created_at)) bad("created_at");
  if (!isInstant(a.expires_at)) bad("expires_at");
  const run = a.workflow_run;
  if (!isObject(run)) bad("workflow_run");
  if (!isId(run.id)) bad("workflow_run.id");
  if (!isId(run.repository_id)) bad("workflow_run.repository_id");
  if (!isId(run.head_repository_id)) bad("workflow_run.head_repository_id");
  if (typeof run.head_branch !== "string") bad("workflow_run.head_branch");
  if (typeof run.head_sha !== "string" || !SHA.test(run.head_sha))
    bad("workflow_run.head_sha");
}

/** Strict shape of GitHub's workflow run attempt record. */
function checkRunShape(r) {
  const bad = (field) => fail("INVALID_METADATA", `Run record: ${field}`);
  if (!isObject(r)) bad("not an object");
  if (!isId(r.id)) bad("id");
  if (!Number.isSafeInteger(r.run_attempt) || r.run_attempt < 1)
    bad("run_attempt");
  for (const field of ["path", "event", "status", "head_branch"])
    if (typeof r[field] !== "string") bad(field);
  if (r.conclusion !== null && typeof r.conclusion !== "string")
    bad("conclusion");
  if (typeof r.head_sha !== "string" || !SHA.test(r.head_sha)) bad("head_sha");
  for (const repo of ["repository", "head_repository"]) {
    if (!isObject(r[repo])) bad(repo);
    if (!isId(r[repo].id)) bad(`${repo}.id`);
    if (typeof r[repo].full_name !== "string") bad(`${repo}.full_name`);
  }
}

/** Sunday step 1: the registered handoff for an edition, or NO_HANDOFF. */
export function resolveHandoff(ledgerState, edition) {
  if (!isSaturdayDate(edition))
    fail("INVALID_EXPECTATION", "Edition must be a Saturday");
  const handoff = findHandoff(ledgerState, edition);
  if (!handoff)
    fail(
      "NO_HANDOFF",
      `No registered research artifact for edition ${edition}`,
    );
  return handoff;
}

/**
 * Sunday step 2: checks GitHub's records for the handoff's artifact and run
 * attempt. Returns what the download and bundle.mjs need, or throws.
 */
export function verifyProvenance({
  handoff,
  artifact,
  run,
  expected,
  isMainCommit,
  now = new Date(),
}) {
  checkExpected(expected);
  if (!isObject(handoff)) fail("NO_HANDOFF", "No handoff to verify");
  if (typeof isMainCommit !== "function")
    fail("INVALID_EXPECTATION", "A main-branch commit check is required");
  checkArtifactShape(artifact);
  checkRunShape(run);

  // The artifact is the registered one, from the registered run attempt.
  if (artifact.id !== handoff.artifactId)
    fail(
      "ARTIFACT_MISMATCH",
      "The artifact record is not the registered artifact",
    );
  if (
    artifact.name !==
    bundleArtifactName(
      handoff.edition,
      handoff.workflowRunId,
      handoff.runAttempt,
    )
  )
    fail(
      "ARTIFACT_MISMATCH",
      "Artifact name does not match edition, run and attempt",
    );
  if (artifact.workflow_run.id !== handoff.workflowRunId)
    fail("ARTIFACT_MISMATCH", "The artifact belongs to another workflow run");
  if (
    artifact.workflow_run.repository_id !== expected.repositoryId ||
    artifact.workflow_run.head_repository_id !== expected.repositoryId
  )
    fail("UNTRUSTED_RUN", "The artifact was not produced in this repository");
  if (artifact.workflow_run.head_branch !== expected.branch)
    fail(
      "UNTRUSTED_RUN",
      "The artifact was not produced on the expected branch",
    );
  if (artifact.workflow_run.head_sha !== run.head_sha)
    fail(
      "ARTIFACT_MISMATCH",
      "Artifact and run records name different commits",
    );
  if (artifact.size_in_bytes < 1 || artifact.size_in_bytes > MAX_ARTIFACT_BYTES)
    fail("ARTIFACT_MISMATCH", "Artifact size is out of range");

  // Still available, with time to download it.
  if (artifact.expired) fail("ARTIFACT_EXPIRED", "The artifact has expired");
  if (Date.parse(artifact.expires_at) < now.getTime() + EXPIRY_MARGIN_MS)
    fail("ARTIFACT_EXPIRED", "The artifact expires too soon to be used");
  if (Date.parse(artifact.created_at) > now.getTime())
    fail("INVALID_METADATA", "Artifact created in the future");

  // The run attempt is the expected research workflow, on main, completed.
  if (
    run.id !== handoff.workflowRunId ||
    run.run_attempt !== handoff.runAttempt
  )
    fail("RUN_MISMATCH", "The run record is not the registered run attempt");
  if (
    run.repository.id !== expected.repositoryId ||
    run.repository.full_name !== expected.repository ||
    run.head_repository.id !== expected.repositoryId ||
    run.head_repository.full_name !== expected.repository
  )
    fail("UNTRUSTED_RUN", "The run did not execute in this repository");
  if (run.path !== expected.workflowPath)
    fail("UNTRUSTED_RUN", "The run is not the research workflow");
  if (run.head_branch !== expected.branch)
    fail("UNTRUSTED_RUN", "The run did not execute on the expected branch");
  if (!expected.events.includes(run.event))
    fail("UNTRUSTED_RUN", `Runs triggered by ${run.event} are not accepted`);
  if (run.status !== "completed" || run.conclusion !== "success")
    fail(
      "RUN_NOT_SUCCESSFUL",
      "The research run attempt did not complete successfully",
    );
  if (isMainCommit(run.head_sha) !== true)
    fail("UNTRUSTED_COMMIT", "The research commit is not on the main branch");

  return {
    edition: handoff.edition,
    reservationId: handoff.reservationId,
    artifactId: handoff.artifactId,
    artifactName: artifact.name,
    workflowRunId: handoff.workflowRunId,
    runAttempt: handoff.runAttempt,
    bundle: {
      digest: handoff.bundleDigest,
      expected: {
        edition: handoff.edition,
        runId: handoff.researchRunId,
        workflow: workflowRefOf(expected),
        mode: "production",
      },
    },
  };
}

/**
 * Sunday step 3: authenticates and decrypts the downloaded bundle with the
 * verified digest and identity. Returns { header, report, draft } for the
 * publication validation stage; throws BundleError on any failure.
 */
export function openVerifiedBundle(bytes, verified, keys) {
  if (!isObject(verified?.bundle))
    fail("NO_HANDOFF", "Provenance has not been verified");
  return openBundle(bytes, {
    digest: verified.bundle.digest,
    expected: verified.bundle.expected,
    keys,
  });
}
