// Phase 4: glue between the GitHub Actions workflows and the Tech Brief
// modules. Each workflow step calls one CLI command here; all logic lives in
// the existing modules (schedule, ledger, research, bundle, provenance,
// publish) and is only wired together.
//
// Saturday (.github/workflows/tech-brief-research.yml):
//   plan-research -> reserve -> research.mjs -> research-outputs -> seal
//   -> upload-artifact -> settle (settlement + handoff in one ledger write)
// Sunday (.github/workflows/tech-brief-publish.yml):
//   plan-publication -> resolve -> GitHub records -> download-artifact
//   -> sunday-prepare (provenance, decryption, publish.mjs) -> check-changes
//   -> commit and push -> verify-live
// Editorial preview (.github/workflows/tech-brief-preview.yml, read-only):
//   plan-publication -> resolve -> GitHub records -> download-artifact
//   -> preview (the same checks with write: false, encrypted to the reviewer
//   key) -> upload-artifact
//
// Editorial approval: while TECH_BRIEF_AUTOMATION is "manual" (or anything
// but "enabled"), publication needs the content digest of the approved
// preview (workflow input approved_digest) and writes only that exact
// content; "enabled" publishes without one, but still enforces one if given.
//
// Activation gate (fail closed): the repository variable TECH_BRIEF_AUTOMATION
// selects a state (ACTIVATION). "off" (or unset, or any other value): no
// production work. "manual": manual dispatches only; schedules do nothing.
// "enabled": schedules and manual dispatches. Paid research, ledger writes
// and publication also need refs/heads/main and an approved sources.json.
// The workflows check the variable before any job starts; gate() checks
// everything again here.
//
// Secrets: OPENAI_API_KEY only in the Saturday research job; the artifact key
// (TECH_BRIEF_ARTIFACT_KEY, *_PREVIOUS during rotation) in that job and the
// Sunday publish job. The rehearsal key below is public and refused here.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { keyId, parseKey, sealBundle } from "./bundle.mjs";
import { correctionsDigest } from "./corrections.mjs";
import { createFetcher } from "./fetch.mjs";
import {
  findHandoff,
  monthSpentForReservation,
  parseLedger,
  readLedger,
  reserve,
  settleAndRegister,
  settleFromReport,
  settlementSummary,
} from "./ledger.mjs";
import {
  bundleArtifactName,
  openVerifiedBundle,
  resolveHandoff,
  verifyProvenance,
} from "./provenance.mjs";
import {
  PREVIEW_FILE,
  buildPreview,
  parseReviewerPublicKey,
  reviewerKeyId,
  sealPreview,
} from "./preview.mjs";
import {
  contentDigest,
  preparePublication,
  readPublishedState,
} from "./publish.mjs";
import { loadConfig } from "./research.mjs";
import { currentEdition, stageDecision } from "./schedule.mjs";
import { loadSourcePolicy } from "./validate.mjs";

export const AUTOMATION_VARIABLE = "TECH_BRIEF_AUTOMATION";
// Events each activation state allows to do production work.
export const ACTIVATION = Object.freeze({
  off: Object.freeze([]),
  manual: Object.freeze(["workflow_dispatch"]),
  enabled: Object.freeze(["schedule", "workflow_dispatch"]),
});
export const LEDGER_BRANCH = "tech-brief-ledger";
export const LEDGER_FILE = "tech-brief-ledger.jsonl";
export const RESEARCH_WORKFLOW_PATH =
  ".github/workflows/tech-brief-research.yml";
export const PRODUCTION_REF = "refs/heads/main";
export const SITE_URL = "https://www.ourfaces.net";
// Public, synthetic-only key for the rehearsal workflow; never accepted for production.
export const REHEARSAL_KEY = createHash("sha256")
  .update(
    "ourfaces-tech-brief rehearsal key: synthetic data only, never a secret",
  )
  .digest();
const BOT = [
  "-c",
  "user.name=github-actions[bot]",
  "-c",
  "user.email=41898282+github-actions[bot]@users.noreply.github.com",
];

export class AutomationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AutomationError";
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new AutomationError(code, message);
};

/** Whether a run may do production work. Anything unexpected means "skip". */
export function gate({ event, ref, automation, policy }) {
  if (!["schedule", "workflow_dispatch"].includes(event))
    return {
      run: "skip",
      reason: `Event ${event} never runs research or publication`,
    };
  // Exact, case-sensitive match; unset or unknown values mean "off".
  const state = Object.hasOwn(ACTIVATION, automation) ? automation : "off";
  if (!ACTIVATION[state].includes(event))
    return {
      run: "skip",
      reason:
        state === "manual"
          ? `Scheduled runs are off (${AUTOMATION_VARIABLE} is "manual")`
          : `Automation is off (${AUTOMATION_VARIABLE} is not "manual" or "enabled")`,
    };
  if (ref !== PRODUCTION_REF)
    return {
      run: "skip",
      reason: `Production runs only from ${PRODUCTION_REF}, not ${ref}`,
    };
  if (policy?.status !== "approved")
    return {
      run: "skip",
      reason: `The source policy is "${policy?.status ?? "unset"}", not approved`,
    };
  return { run: "production", reason: `Automation ${state}` };
}

const triggerOf = (event) => (event === "schedule" ? "schedule" : "manual");

/**
 * Saturday: should research run, and for which edition? Scheduled triggers
 * only make up for missed or dropped schedules: once any run has reserved
 * budget for the edition (whatever its outcome), later scheduled triggers do
 * nothing. Retrying is a deliberate manual recovery, which stops only when a
 * handoff for the edition already exists.
 */
export function planResearch({
  now,
  event,
  ref,
  automation,
  policy,
  edition = null,
  ledgerState,
  publishedEdition,
}) {
  const g = gate({ event, ref, automation, policy });
  if (g.run !== "production") return { ...g, due: false };
  if (!ledgerState)
    fail("LEDGER_MISSING", "The spending ledger is not initialised");
  const trigger = triggerOf(event);
  const target =
    trigger === "manual" && edition ? edition : currentEdition(now);
  const attempted = [...ledgerState.reservations.values()].some(
    (entry) => entry.reserve.edition === target,
  );
  const done =
    trigger === "schedule"
      ? attempted
      : Boolean(findHandoff(ledgerState, target));
  const decision = stageDecision("research", {
    now,
    trigger,
    edition: trigger === "manual" ? target : null,
    publishedEdition,
    completedEdition: done ? target : null,
  });
  return {
    run: decision.due ? "production" : "skip",
    due: decision.due,
    trigger,
    edition: decision.edition,
    code: decision.code,
    reason: decision.reason,
  };
}

/** Sunday: should publication run, and for which edition? */
export function planPublication({
  now,
  event,
  ref,
  automation,
  policy,
  edition = null,
  publishedEdition,
}) {
  const g = gate({ event, ref, automation, policy });
  if (g.run !== "production") return { ...g, due: false };
  const trigger = triggerOf(event);
  const decision = stageDecision("publication", {
    now,
    trigger,
    edition: trigger === "manual" ? edition || currentEdition(now) : null,
    publishedEdition,
  });
  return {
    run: decision.due ? "production" : "skip",
    due: decision.due,
    trigger,
    edition: decision.edition,
    code: decision.code,
    reason: decision.reason,
  };
}

export const reservationId = (runId, attempt) => `gh-${runId}-${attempt}`;

export function runGit(dir, args) {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * One ledger update on the ledger branch: start from the remote, apply,
 * commit, push without force, then confirm the new record is on the remote.
 * A rejected push means another writer won: start again from the remote.
 * Ledger refusals (budget, corruption, conflicts) are never retried.
 */
export function ledgerTransaction({
  dir,
  apply,
  message,
  git = runGit,
  attempts = 3,
  branch = LEDGER_BRANCH,
  file = LEDGER_FILE,
  now = () => new Date(),
}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    git(dir, ["fetch", "origin", branch]);
    git(dir, ["reset", "--hard", `origin/${branch}`]);
    const result = apply(join(dir, file));
    if (!result.appended) return { ...result, pushed: false, attempt };
    git(dir, ["add", file]);
    git(dir, [...BOT, "commit", "-m", message]);
    try {
      git(dir, ["push", "origin", `HEAD:${branch}`]);
    } catch {
      continue;
    }
    git(dir, ["fetch", "origin", branch]);
    const remote = parseLedger(git(dir, ["show", `origin/${branch}:${file}`]), {
      now: now(),
    });
    if (!remote.hashes.includes(result.head))
      fail(
        "LEDGER_NOT_DURABLE",
        "The pushed ledger record is not on the remote branch",
      );
    return { ...result, pushed: true, attempt };
  }
  fail("LEDGER_CONFLICT", `The ledger push was rejected ${attempts} times`);
}

/** Ledger step: reserve the per-run ceiling; repeating it for a recorded reservation is a no-op. */
export const reserveStep =
  ({ id, edition, kind, supersedes = null, config, at = new Date() }) =>
  (path) => {
    const { state } = readLedger(path, { now: at });
    const existing = state.reservations.get(id);
    if (existing && !existing.settlement && !existing.supersededBy)
      return {
        appended: false,
        head: state.head,
        reservationId: id,
        monthSpentUsd: monthSpentForReservation(state, id),
      };
    return {
      ...reserve(path, { id, edition, kind, supersedes, config, at }),
      reservationId: id,
    };
  };

/** Ledger step: settle a run, with its handoff when it uploaded a bundle. */
export const settleStep =
  ({ id, summary, handoff = null, at = new Date() }) =>
  (path) =>
    handoff
      ? settleAndRegister(path, { id, report: summary, handoff, at })
      : settleFromReport(path, { id, report: summary, at });

/** True when `sha` is an ancestor of (or equal to) `ref` in the repository at `dir`. */
export function gitIsAncestor(sha, ref, { dir, git = runGit }) {
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return false;
  try {
    git(dir, ["merge-base", "--is-ancestor", sha, ref]);
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

function refuseRehearsalKey(keys) {
  const rehearsal = keyId(REHEARSAL_KEY);
  if (keys.some((k) => keyId(k) === rehearsal))
    fail(
      "REHEARSAL_KEY",
      "The public rehearsal key is never accepted for production",
    );
}

/** Production artifact keys from the environment (current, and previous during a rotation). */
export function keysFromEnvironment(env) {
  const keys = [parseKey(env.TECH_BRIEF_ARTIFACT_KEY ?? "")];
  if (env.TECH_BRIEF_ARTIFACT_KEY_PREVIOUS)
    keys.push(parseKey(env.TECH_BRIEF_ARTIFACT_KEY_PREVIOUS));
  refuseRehearsalKey(keys);
  return keys;
}

/** The expected identity of the Saturday research workflow, from the Actions environment. */
export function expectedResearchWorkflow(env) {
  return {
    repository: env.GITHUB_REPOSITORY,
    repositoryId: Number(env.GITHUB_REPOSITORY_ID),
    workflowPath: RESEARCH_WORKFLOW_PATH,
    branch: "main",
    events: ["schedule", "workflow_dispatch"],
  };
}

/** The single file inside a downloaded artifact folder. */
export function singleFile(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(dir);
  if (files.length !== 1)
    fail(
      "ARTIFACT_CONTENT",
      `Expected one file in the artifact, found ${files.length}`,
    );
  return files[0];
}

/**
 * Sunday: locate the registered artifact, check its provenance, decrypt it
 * and prepare the public files. Decrypted content stays in memory.
 */
export async function sundayPrepare({
  ledgerState,
  edition,
  artifact,
  run,
  expected,
  isMainCommit,
  bundleBytes,
  keys,
  policy,
  config,
  fetcher,
  contentDir,
  now = new Date(),
  trigger = "schedule",
  write = true,
  approvedDigest = null,
  requireApproval = false,
  corrections = null,
}) {
  refuseRehearsalKey(keys);
  const handoff = resolveHandoff(ledgerState, edition);
  const verified = verifyProvenance({
    handoff,
    artifact,
    run,
    expected,
    isMainCommit,
    now,
  });
  const { report, draft } = openVerifiedBundle(bundleBytes, verified, keys);
  const outcome = await preparePublication({
    report,
    draft,
    policy,
    config,
    fetcher,
    contentDir,
    now,
    trigger,
    write,
    approvedDigest,
    requireApproval,
    corrections,
    handoff,
  });
  return {
    ...outcome,
    reservationId: handoff.reservationId,
    artifactId: handoff.artifactId,
    handoff,
  };
}

/**
 * Editorial corrections for a Sunday run, checked before anything is read or
 * decrypted. `use` is the workflow's use_corrections input ("true"; "false"
 * or empty on a schedule), `text` the decoded corrections file (null or ""
 * when none was written) and `expectedDigest` the corrections_digest input.
 * Off: nothing may be supplied. On: manual dispatch only, a non-empty file and
 * exactly the expected digest. Returns the text to apply, or null.
 */
export function correctionsInput({ event, use, text, expectedDigest }) {
  const given = typeof text === "string" && text.length > 0;
  const digest = expectedDigest ?? "";
  if (use === "false" || use === "" || use === null || use === undefined) {
    if (given || digest)
      fail(
        "CORRECTIONS_UNEXPECTED",
        "Corrections or a corrections digest were supplied without use_corrections",
      );
    return null;
  }
  if (use !== "true")
    fail("CORRECTIONS_FLAG", "use_corrections must be true or false");
  if (event !== "workflow_dispatch")
    fail(
      "CORRECTIONS_NOT_MANUAL",
      "Editorial corrections are only applied in a manual dispatch",
    );
  if (!given)
    fail(
      "CORRECTIONS_MISSING",
      "use_corrections is true but no corrections were supplied",
    );
  if (!/^[0-9a-f]{64}$/.test(digest))
    fail(
      "CORRECTIONS_DIGEST_REQUIRED",
      "use_corrections needs corrections_digest: the SHA-256 of the corrections file",
    );
  if (correctionsDigest(text) !== digest)
    fail(
      "CORRECTIONS_DIGEST_MISMATCH",
      "The supplied corrections differ from the expected corrections digest",
    );
  return text;
}

/** Whether publication needs an editorial approval: always, unless automation is fully enabled. */
export const approvalRequired = (automation) => automation !== "enabled";

/** The preview artifact name; distinct from the research bundle, which publication reads by id. */
export const previewArtifactName = (edition, workflowRunId, runAttempt) =>
  `tech-brief-preview-${edition}-${workflowRunId}-${runAttempt}`;

/**
 * Editorial preview: the Sunday checks of sundayPrepare with write: false
 * (real clock, real source recheck), then the public result encrypted to the
 * reviewer's public key. The reviewer key is checked before anything is
 * decrypted. Writes nothing; returns { status, edition, ... } and, when
 * checked, the sealed preview.
 */
export async function previewSunday({
  reviewerPublicKey,
  previewRun = {},
  now = new Date(),
  ...inputs
}) {
  const recipient = parseReviewerPublicKey(reviewerPublicKey);
  const outcome = await sundayPrepare({
    ...inputs,
    now,
    trigger: "manual",
    write: false,
  });
  if (outcome.status !== "checked")
    return { status: outcome.status, edition: outcome.edition };
  const payload = buildPreview({
    outcome,
    handoff: outcome.handoff,
    previewRun,
    now,
  });
  const sealed = sealPreview({ payload, recipient, now });
  return {
    status: "checked",
    edition: outcome.edition,
    stories: JSON.parse(outcome.text).stories.length,
    dropped: outcome.dropped.length,
    reviewerKeyId: reviewerKeyId(recipient),
    corrections: outcome.corrections ?? null,
    sealed,
  };
}

/** Step outputs for an applied corrections document: digests and counts only, never text. */
const correctionOutputs = (record) => ({
  corrections_digest: record?.correctionsDigest ?? "",
  original_digest: record?.originalDigest ?? "",
  revised: record ? record.revised.length : 0,
  excluded: record ? record.excluded.length : 0,
});

/**
 * Before the commit: the two public files must be byte-identical and, when an
 * approval is given or required, have exactly the approved content digest.
 */
export function checkApprovedFiles({
  contentDir,
  edition,
  approvedDigest = null,
  requireApproval = false,
}) {
  if (requireApproval && approvedDigest === null)
    fail(
      "APPROVAL_REQUIRED",
      "Supervised publication needs an approved digest",
    );
  if (approvedDigest === null) return null;
  const latest = readFileSync(join(contentDir, "latest.json"), "utf8");
  const archive = readFileSync(
    join(contentDir, "editions", `${edition}.json`),
    "utf8",
  );
  if (latest !== archive || contentDigest(latest) !== approvedDigest)
    fail(
      "APPROVAL_MISMATCH",
      "The files to commit differ from the approved editorial preview",
    );
  return approvedDigest;
}

/**
 * The working tree may differ from the commit only in this edition's public
 * files; latest.json must be among them. Returns the paths to commit.
 */
export function checkPublicationChanges(
  porcelain,
  { edition, contentPath = "src/content/tech-brief" },
) {
  const allowed = new Set([
    `${contentPath}/latest.json`,
    `${contentPath}/editions/${edition}.json`,
  ]);
  const paths = porcelain
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""));
  const unexpected = paths.filter((p) => p.includes(" -> ") || !allowed.has(p));
  if (unexpected.length)
    fail("UNEXPECTED_CHANGES", `Unexpected changes: ${unexpected.join(", ")}`);
  if (!paths.includes(`${contentPath}/latest.json`))
    fail("NOTHING_TO_PUBLISH", "latest.json is unchanged");
  return paths;
}

/** After the push: both Insights pages must show the new edition. */
export async function verifyLive({
  edition,
  baseUrl = SITE_URL,
  fetchImpl = fetch,
  attempts = 30,
  waitMs = 30_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const marker = `data-edition="${edition}"`;
  const pages = ["/insights", "/fr/insights"];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const shown = await Promise.all(
      pages.map(async (path) => {
        try {
          const response = await fetchImpl(new URL(path, baseUrl), {
            headers: { "cache-control": "no-cache" },
            signal: AbortSignal.timeout(20_000),
          });
          return response.ok && (await response.text()).includes(marker);
        } catch {
          return false;
        }
      }),
    );
    if (shown.every(Boolean)) return { ok: true, attempt, pages };
    if (attempt < attempts) await sleep(waitMs);
  }
  fail(
    "LIVE_NOT_UPDATED",
    `The live Insights pages do not show edition ${edition}`,
  );
}

// CLI ------------------------------------------------------------------------------------------
// Each command prints one JSON object (identifiers, codes and counts only) and
// writes the same values as step outputs when GITHUB_OUTPUT is set.
// Exit 0 ok (including "nothing to do" on a schedule), 4 refused, 1 usage.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, ...args] = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? "") : null;
  };
  const env = process.env;
  const emit = (code, value) => {
    if (env.GITHUB_OUTPUT)
      for (const [k, v] of Object.entries(value))
        if (v !== undefined && v !== null && typeof v !== "object")
          appendFileSync(
            env.GITHUB_OUTPUT,
            `${k}=${String(v).replace(/[\r\n]/g, " ")}\n`,
          );
    console.log(JSON.stringify(value));
    process.exit(code);
  };
  const policyFile = new URL("./sources.json", import.meta.url);
  const ledgerPath = () => join(option("--ledger-dir") ?? "", LEDGER_FILE);
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  // Inputs shared by sunday-prepare and preview (the same checks, the real clock).
  const sundayInputs = async () => {
    // Editorial corrections first: refused before the ledger, bundle or keys are read.
    const correctionsFile = option("--corrections");
    const corrections = correctionsInput({
      event: env.GITHUB_EVENT_NAME,
      use: option("--use-corrections") ?? "false",
      text: correctionsFile ? readFileSync(correctionsFile, "utf8") : null,
      expectedDigest: option("--corrections-digest"),
    });
    const repoDir = option("--repo-dir") ?? ".";
    const policy = await loadSourcePolicy(policyFile);
    const now = new Date();
    return {
      ledgerState: readLedger(ledgerPath(), { now }).state,
      edition: option("--edition"),
      artifact: readJson(option("--artifact-json") ?? ""),
      run: readJson(option("--run-json") ?? ""),
      expected: expectedResearchWorkflow(env),
      isMainCommit: (sha) =>
        gitIsAncestor(sha, "origin/main", { dir: repoDir }),
      bundleBytes: readFileSync(singleFile(option("--bundle-dir") ?? "")),
      keys: keysFromEnvironment(env),
      policy,
      config: await loadConfig(),
      fetcher: createFetcher({ sourcePolicy: policy }),
      contentDir: option("--content-dir"),
      now,
      corrections,
    };
  };
  try {
    const now = new Date();
    switch (command) {
      case "plan-research":
      case "plan-publication": {
        const policy = await loadSourcePolicy(policyFile);
        const published = readPublishedState(
          option("--content-dir") ?? "",
        ).latestEdition;
        const common = {
          now,
          event: env.GITHUB_EVENT_NAME,
          ref: env.GITHUB_REF,
          automation: env[AUTOMATION_VARIABLE],
          policy,
          edition: option("--edition") || null,
          publishedEdition: published,
        };
        const plan =
          command === "plan-research"
            ? planResearch({
                ...common,
                ledgerState: existsSync(ledgerPath())
                  ? readLedger(ledgerPath(), { now }).state
                  : null,
              })
            : planPublication(common);
        // A manual run that cannot proceed is an error the operator should see.
        emit(
          plan.run === "production" || env.GITHUB_EVENT_NAME === "schedule"
            ? 0
            : 4,
          {
            run: plan.run,
            edition: plan.edition ?? "",
            trigger: plan.trigger ?? "",
            code: plan.code ?? "",
            reason: plan.reason,
          },
        );
        break;
      }
      case "reserve": {
        const result = ledgerTransaction({
          dir: option("--ledger-dir"),
          message: `Reserve Tech Brief research ${option("--edition")}`,
          apply: reserveStep({
            id: reservationId(option("--run-id"), option("--run-attempt")),
            edition: option("--edition"),
            kind: env.GITHUB_EVENT_NAME === "schedule" ? "scheduled" : "manual",
            supersedes: option("--supersedes") || null,
            config: await loadConfig(),
          }),
        });
        emit(0, {
          reservation_id: result.reservationId,
          month_spent: result.monthSpentUsd,
          pushed: result.pushed,
        });
        break;
      }
      case "research-outputs": {
        const dir = option("--out") ?? "";
        // No report (research crashed or was refused): fail the job so the
        // alert fires; settlement is skipped and the reservation stays counted.
        if (!existsSync(join(dir, "report.json")))
          emit(4, { status: "missing", summary: "" });
        const report = readJson(join(dir, "report.json"));
        emit(0, {
          status: report.status,
          summary: JSON.stringify(settlementSummary(report)),
          has_draft: existsSync(join(dir, "draft-edition.json")),
        });
        break;
      }
      case "seal": {
        const dir = option("--research-dir") ?? "";
        const [key] = keysFromEnvironment(env);
        const sealed = sealBundle({
          report: readJson(join(dir, "report.json")),
          draft: readJson(join(dir, "draft-edition.json")),
          workflow: env.GITHUB_WORKFLOW_REF,
          key,
        });
        const outDir = option("--out-dir") ?? "";
        mkdirSync(outDir, { recursive: true });
        const path = join(outDir, "research-bundle.bin");
        writeFileSync(path, sealed.bytes, { flag: "wx" });
        emit(0, {
          artifact_name: bundleArtifactName(
            sealed.header.edition,
            env.GITHUB_RUN_ID,
            env.GITHUB_RUN_ATTEMPT,
          ),
          path,
          bundle_digest: sealed.digest,
          edition: sealed.header.edition,
        });
        break;
      }
      case "settle": {
        const artifactId = option("--artifact-id");
        const handoff = artifactId
          ? {
              workflowRunId: Number(option("--workflow-run-id")),
              runAttempt: Number(option("--run-attempt")),
              artifactId: Number(artifactId),
              bundleDigest: option("--bundle-digest"),
            }
          : null;
        const result = ledgerTransaction({
          dir: option("--ledger-dir"),
          message: `Settle Tech Brief research ${option("--reservation")}`,
          apply: settleStep({
            id: option("--reservation"),
            summary: JSON.parse(option("--summary") ?? ""),
            handoff,
          }),
        });
        emit(0, {
          settled: true,
          handoff: Boolean(handoff),
          pushed: result.pushed,
        });
        break;
      }
      case "resolve": {
        const handoff = resolveHandoff(
          readLedger(ledgerPath(), { now }).state,
          option("--edition"),
        );
        emit(0, {
          artifact_id: handoff.artifactId,
          workflow_run_id: handoff.workflowRunId,
          run_attempt: handoff.runAttempt,
          reservation_id: handoff.reservationId,
        });
        break;
      }
      case "sunday-prepare": {
        const outcome = await sundayPrepare({
          ...(await sundayInputs()),
          trigger: env.GITHUB_EVENT_NAME === "schedule" ? "schedule" : "manual",
          approvedDigest: option("--approved-digest") || null,
          requireApproval: approvalRequired(env[AUTOMATION_VARIABLE]),
        });
        emit(0, {
          status: outcome.status,
          edition: outcome.edition,
          files: outcome.files.join(" "),
          dropped: outcome.dropped.length,
          content_digest: outcome.contentDigest ?? "",
          ...correctionOutputs(outcome.corrections),
        });
        break;
      }
      case "preview": {
        // The reviewer key is checked first: without it nothing is decrypted.
        const reviewerPublicKey = env.TECH_BRIEF_REVIEWER_PUBLIC_KEY ?? "";
        parseReviewerPublicKey(reviewerPublicKey);
        const outDir = option("--out-dir") ?? "";
        if (!outDir) fail("USAGE", "--out-dir is required");
        const result = await previewSunday({
          ...(await sundayInputs()),
          reviewerPublicKey,
          previewRun: {
            workflowRunId: Number(env.GITHUB_RUN_ID) || null,
            runAttempt: Number(env.GITHUB_RUN_ATTEMPT) || null,
          },
        });
        if (result.status !== "checked")
          emit(0, { status: result.status, edition: result.edition });
        mkdirSync(outDir, { recursive: true });
        const path = join(outDir, PREVIEW_FILE);
        writeFileSync(path, result.sealed.bytes, { flag: "wx" });
        emit(0, {
          status: result.status,
          edition: result.edition,
          stories: result.stories,
          dropped: result.dropped,
          ...correctionOutputs(result.corrections),
          reviewer_key_id: result.reviewerKeyId,
          artifact_name: previewArtifactName(
            result.edition,
            env.GITHUB_RUN_ID,
            env.GITHUB_RUN_ATTEMPT,
          ),
          path,
          preview_digest: result.sealed.digest,
        });
        break;
      }
      case "check-changes": {
        const repoDir = option("--repo-dir") ?? ".";
        const paths = checkPublicationChanges(
          runGit(repoDir, ["status", "--porcelain", "--untracked-files=all"]),
          { edition: option("--edition") },
        );
        const approved = checkApprovedFiles({
          contentDir: join(repoDir, "src/content/tech-brief"),
          edition: option("--edition"),
          approvedDigest: option("--approved-digest") || null,
          requireApproval: approvalRequired(env[AUTOMATION_VARIABLE]),
        });
        emit(0, { files: paths.join(" "), approved_digest: approved ?? "" });
        break;
      }
      case "verify-live": {
        const result = await verifyLive({
          edition: option("--edition"),
          baseUrl: option("--base-url") || SITE_URL,
        });
        emit(0, { live: result.ok, attempt: result.attempt });
        break;
      }
      default:
        emit(1, {
          ok: false,
          code: "USAGE",
          message: `Unknown command ${command}`,
        });
    }
  } catch (error) {
    // Codes and messages only: never content, keys or tokens.
    emit(4, {
      ok: false,
      code: error?.code ?? "ERROR",
      message: error?.code
        ? String(error.message).slice(0, 300)
        : "Unexpected failure",
    });
  }
}
