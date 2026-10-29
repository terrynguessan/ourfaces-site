// Editorial preview (preview.mjs and automation.mjs previewSunday), offline:
// reviewer keys, encryption and tamper detection, the read-only preview flow
// against a synthetic ledger, GitHub records and research bundle, the
// publication window, the approval binding between preview and publication,
// and the local CLI. No network, no real credentials, no OpenAI calls.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
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
  REHEARSAL_KEY,
  RESEARCH_WORKFLOW_PATH,
  approvalRequired,
  checkApprovedFiles,
  previewArtifactName,
  previewSunday,
  sundayPrepare,
} from "../automation.mjs";
import { sealBundle } from "../bundle.mjs";
import {
  initLedger,
  readLedger,
  recordOpening,
  reserve,
  settleAndRegister,
} from "../ledger.mjs";
import {
  PREVIEW_FILE,
  buildPreview,
  generateReviewerKeyPair,
  insideRepository,
  openPreview,
  parseReviewerPrivateKey,
  parseReviewerPublicKey,
  previewProblems,
  renderPreview,
  reviewerKeyId,
  sealPreview,
} from "../preview.mjs";
import { bundleArtifactName, workflowRefOf } from "../provenance.mjs";
import { contentDigest } from "../publish.mjs";
import {
  REHEARSAL_WORKFLOW_PATH,
  fixtureFetcher,
  rehearsalClock,
  rehearsalResult,
} from "../rehearsal.mjs";
import { loadConfig } from "../research.mjs";
import { loadSourcePolicy } from "../validate.mjs";

const config = await loadConfig();
// TEST-ONLY approved copy of the source lists.
const APPROVED = Object.freeze({
  ...(await loadSourcePolicy(new URL("../sources.json", import.meta.url))),
  status: "approved",
});
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
const RUN_ID = 9100000001;
const ARTIFACT_ID = 4100000001;
const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
const CONTENT = join(REPOSITORY, "src/content/tech-brief");
const AUTOMATION = fileURLToPath(new URL("../automation.mjs", import.meta.url));
const PREVIEW = fileURLToPath(new URL("../preview.mjs", import.meta.url));
const REVIEWER = generateReviewerKeyPair();
const REVIEWER_PRIVATE = parseReviewerPrivateKey(REVIEWER.privateKeyPem);
const STRANGER = generateReviewerKeyPair();

const temp = (name) => mkdtempSync(join(tmpdir(), `tb-preview-${name}-`));
const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** The same bytes with the unused low bits of the last base64 digit set. */
const nonCanonical = (text) =>
  `${text.slice(0, -2)}${BASE64[BASE64.indexOf(text.at(-2)) | 1]}=`;
const codeOf = async (fn) => {
  try {
    await fn();
  } catch (error) {
    return error?.code ?? `UNCODED: ${error?.message}`;
  }
  return "NO_ERROR";
};
/** Every file under a folder, with its content. */
const snapshot = (dir) => {
  const files = {};
  const walk = (d, prefix) => {
    for (const entry of readdirSync(d, { withFileTypes: true }))
      if (entry.isDirectory())
        walk(join(d, entry.name), `${prefix}${entry.name}/`);
      else
        files[`${prefix}${entry.name}`] = readFileSync(
          join(d, entry.name),
          "utf8",
        );
  };
  walk(dir, "");
  return files;
};

/** The synthetic research result, as a paid production run would report it. */
function productionResult(runId = "run-1a2b3c4d") {
  const result = rehearsalResult(EDITION);
  result.report = {
    ...result.report,
    runId,
    startedAt: new Date(RESERVED_AT.getTime() + 3 * 60_000).toISOString(),
    finishedAt: new Date(RESERVED_AT.getTime() + 8 * 60_000).toISOString(),
    budget: { runTotalCountedUsd: 0.162693 },
  };
  result.draft = {
    ...result.draft,
    generation: {
      ...result.draft.generation,
      runId,
      estimatedCostUsd: 0.162693,
    },
  };
  return result;
}

/** A ledger with a settled, registered research run, and its sealed bundle. */
function saturday() {
  const dir = temp("ledger");
  const path = join(dir, "tech-brief-ledger.jsonl");
  initLedger(path, { at: new Date("2026-09-20T00:00:00.000Z") });
  recordOpening(path, {
    month: "2026-10",
    usd: "0.694294",
    ref: "test",
    at: new Date("2026-10-01T00:00:00.000Z"),
  });
  const id = `gh-${RUN_ID}-1`;
  reserve(path, {
    id,
    edition: EDITION,
    kind: "manual",
    supersedes: null,
    config,
    at: RESERVED_AT,
  });
  const research = productionResult();
  const sealed = sealBundle({
    report: research.report,
    draft: research.draft,
    workflow: workflowRefOf(EXPECTED),
    key: KEY,
  });
  settleAndRegister(path, {
    id,
    report: research.report,
    handoff: {
      workflowRunId: RUN_ID,
      runAttempt: 1,
      artifactId: ARTIFACT_ID,
      bundleDigest: sealed.digest,
    },
    at: new Date(RESERVED_AT.getTime() + 10 * 60_000),
  });
  return { path, sealed, research };
}

/** GitHub's artifact and run-attempt records for the handoff (synthetic). */
const records = ({
  artifact = {},
  run = {},
  path = RESEARCH_WORKFLOW_PATH,
} = {}) => ({
  artifact: {
    id: ARTIFACT_ID,
    name: bundleArtifactName(EDITION, RUN_ID, 1),
    size_in_bytes: 20000,
    expired: false,
    created_at: "2026-10-25T00:21:43Z",
    expires_at: "2027-01-23T00:18:04Z",
    workflow_run: {
      id: RUN_ID,
      repository_id: 123456,
      head_repository_id: 123456,
      head_branch: "main",
      head_sha: SHA,
    },
    ...artifact,
  },
  run: {
    id: RUN_ID,
    run_attempt: 1,
    path,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: SHA,
    repository: { id: 123456, full_name: "owner/ourfaces-site" },
    head_repository: { id: 123456, full_name: "owner/ourfaces-site" },
    ...run,
  },
});

const LEDGER = saturday();
const contentCopy = () => {
  const dir = join(temp("content"), "tech-brief");
  cpSync(CONTENT, dir, { recursive: true });
  return dir;
};
/** The Sunday inputs, as the preview and publish jobs pass them. */
const inputs = ({
  now = SUNDAY,
  bytes = LEDGER.sealed.bytes,
  keys = [KEY],
  recs = records(),
  contentDir = contentCopy(),
  edition = EDITION,
  pages = rehearsalResult(EDITION).pages,
} = {}) => ({
  ledgerState: readLedger(LEDGER.path, { now }).state,
  edition,
  ...recs,
  expected: EXPECTED,
  isMainCommit: (sha) => sha === SHA,
  bundleBytes: bytes,
  keys,
  policy: APPROVED,
  config,
  fetcher: fixtureFetcher(pages),
  contentDir,
  now,
});
const preview = (args = {}, { reviewerPublicKey = REVIEWER.publicKey } = {}) =>
  previewSunday({
    ...inputs(args),
    reviewerPublicKey,
    previewRun: { workflowRunId: 9200000001, runAttempt: 1 },
  });

// The reference preview used by most tests below.
const PREVIEWED = await preview();
const PAYLOAD = openPreview(PREVIEWED.sealed.bytes, REVIEWER_PRIVATE);
const STORIES = JSON.parse(PAYLOAD.publication).stories;

// --- Reviewer keys ---------------------------------------------------------------------------

test("reviewer keys: X25519 only, exact base64 SPKI, stable key id; private keys from PEM", () => {
  const key = parseReviewerPublicKey(REVIEWER.publicKey);
  assert.equal(key.asymmetricKeyType, "x25519");
  assert.equal(reviewerKeyId(key), REVIEWER.keyId);
  assert.match(REVIEWER.keyId, /^[0-9a-f]{16}$/);
  assert.notEqual(REVIEWER.keyId, STRANGER.keyId);
  assert.match(REVIEWER.privateKeyPem, /^-----BEGIN PRIVATE KEY-----\n/);
  const ed25519 = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const cases = [
    [undefined, "REVIEWER_KEY_MISSING"],
    ["", "REVIEWER_KEY_MISSING"],
    ["not a key", "REVIEWER_KEY_INVALID"],
    [` ${REVIEWER.publicKey}`, "REVIEWER_KEY_INVALID"],
    [`${REVIEWER.publicKey}\n`, "REVIEWER_KEY_INVALID"],
    // Non-canonical base64 (padding bits set) decodes to the same key: refused.
    [nonCanonical(REVIEWER.publicKey), "REVIEWER_KEY_INVALID"],
    [ed25519, "REVIEWER_KEY_INVALID"],
    [REVIEWER.privateKeyPem, "REVIEWER_KEY_INVALID"],
    [KEY.toString("base64"), "REVIEWER_KEY_INVALID"],
  ];
  for (const [text, code] of cases)
    assert.throws(
      () => parseReviewerPublicKey(text),
      { code },
      JSON.stringify(text)?.slice(0, 40),
    );
  // The public key is never accepted where the private key is needed.
  for (const pem of [
    "garbage",
    rsa.privateKey.export({ type: "pkcs8", format: "pem" }),
    parseReviewerPublicKey(REVIEWER.publicKey).export({
      type: "spki",
      format: "pem",
    }),
  ])
    assert.throws(() => parseReviewerPrivateKey(pem), {
      code: "REVIEWER_KEY_INVALID",
    });
});

// --- Encryption ------------------------------------------------------------------------------

test("sealed previews open only with the reviewer's private key and carry no plaintext", () => {
  const { bytes } = PREVIEWED.sealed;
  assert.equal(bytes.subarray(0, 8).toString("ascii"), "OFTBPREV");
  // None of the public text or the digest is readable in the file.
  const raw = bytes.toString("latin1");
  for (const s of STORIES)
    for (const text of [s.en.headline, s.fr.headline, s.en.summary, s.url])
      assert.ok(!raw.includes(text), text);
  assert.ok(!raw.includes(PAYLOAD.contentDigest));
  // A fresh ephemeral key and IV each time.
  const twice = sealPreview({
    payload: PAYLOAD,
    recipient: parseReviewerPublicKey(REVIEWER.publicKey),
  });
  assert.notDeepEqual(twice.bytes, bytes);
  assert.deepEqual(openPreview(twice.bytes, REVIEWER_PRIVATE), PAYLOAD);
  // Another reviewer key cannot open it.
  assert.throws(
    () => openPreview(bytes, parseReviewerPrivateKey(STRANGER.privateKeyPem)),
    { code: "REVIEWER_KEY_MISMATCH" },
  );
  assert.throws(
    () => openPreview(bytes, parseReviewerPublicKey(REVIEWER.publicKey)),
    {
      code: "REVIEWER_KEY_INVALID",
    },
  );
});

test("tampered, truncated, extended or foreign files are refused", () => {
  const { bytes } = PREVIEWED.sealed;
  const headerLength = bytes.readUInt16BE(9);
  const headerEnd = 11 + headerLength;
  const flip = (offset) => {
    const copy = Buffer.from(bytes);
    copy[offset] ^= 1;
    return copy;
  };
  const header = bytes.subarray(11, headerEnd).toString("utf8");
  // A header rewritten to name another reviewer key (still canonical) fails authentication.
  const renamed = Buffer.concat([
    bytes.subarray(0, 11),
    Buffer.from(header.replace(REVIEWER.keyId, STRANGER.keyId), "utf8"),
    bytes.subarray(headerEnd),
  ]);
  const cases = [
    ["ciphertext", flip(headerEnd + 12 + 5), "AUTHENTICATION_FAILED"],
    ["tag", flip(bytes.length - 1), "AUTHENTICATION_FAILED"],
    ["iv", flip(headerEnd + 1), "AUTHENTICATION_FAILED"],
    [
      "createdAt digit",
      Buffer.concat([
        bytes.subarray(0, 11),
        Buffer.from(
          header.replace(
            /:(\d)(\d)\./,
            (m, a, b) => `:${a}${(Number(b) + 1) % 10}.`,
          ),
          "utf8",
        ),
        bytes.subarray(headerEnd),
      ]),
      "AUTHENTICATION_FAILED",
    ],
    ["magic", flip(0), "MALFORMED"],
    ["version", flip(8), "UNSUPPORTED_VERSION"],
    ["truncated", bytes.subarray(0, bytes.length - 1), "MALFORMED"],
    ["extended", Buffer.concat([bytes, Buffer.from([0])]), "MALFORMED"],
    ["empty", Buffer.alloc(0), "MALFORMED"],
    ["research bundle", LEDGER.sealed.bytes, "MALFORMED"],
  ];
  for (const [name, data, code] of cases)
    assert.throws(() => openPreview(data, REVIEWER_PRIVATE), { code }, name);
  assert.throws(
    () => openPreview(renamed, parseReviewerPrivateKey(STRANGER.privateKeyPem)),
    { code: "AUTHENTICATION_FAILED" },
  );
});

test("payloads hold public content only and must be self-consistent", () => {
  assert.deepEqual(previewProblems(PAYLOAD), []);
  const json = JSON.stringify(PAYLOAD);
  for (const secret of [
    "evidence",
    "quote",
    "claims",
    "verification",
    "editorial",
    "estimatedCostUsd",
    "Synthetic rehearsal claim",
  ])
    assert.ok(!json.includes(secret), secret);
  const withStory = (story) => ({
    ...PAYLOAD,
    dropped: [{ id: story.id, reasons: ["SOURCE_UNAVAILABLE:HTTP_STATUS"] }],
    droppedStories: [story],
  });
  const cases = [
    ["extra field", { ...PAYLOAD, report: {} }, "fields"],
    [
      "edited text",
      { ...PAYLOAD, publication: PAYLOAD.publication.replace("e", "E") },
      "contentDigest",
    ],
    [
      "free-text warning",
      { ...PAYLOAD, warnings: ["see the quote here"] },
      "warnings",
    ],
    [
      "evidence in a dropped story",
      withStory({ ...STORIES[0], evidence: { quote: "x" } }),
      "droppedStories",
    ],
    [
      "dropped story without reasons",
      { ...withStory(STORIES[0]), dropped: [] },
      "droppedStories",
    ],
    ["no source", { ...PAYLOAD, source: null }, "source"],
  ];
  for (const [name, payload, problem] of cases)
    assert.ok(previewProblems(payload).includes(problem), name);
  assert.ok(previewProblems(withStory(STORIES[0])).length === 0);
  // Sealing refuses an inconsistent payload, so it can never be encrypted.
  assert.throws(
    () =>
      sealPreview({
        payload: { ...PAYLOAD, report: {} },
        recipient: parseReviewerPublicKey(REVIEWER.publicKey),
      }),
    { code: "INVALID_PREVIEW" },
  );
  assert.throws(
    () => buildPreview({ outcome: { status: "prepared" }, handoff: {} }),
    { code: "NOT_CHECKED" },
  );
});

// --- The preview flow ------------------------------------------------------------------------

test("preview: the exact public edition, warnings and provenance, encrypted; nothing written anywhere", async () => {
  assert.equal(PREVIEWED.status, "checked");
  assert.deepEqual(
    [
      PREVIEWED.edition,
      PREVIEWED.stories,
      PREVIEWED.dropped,
      PREVIEWED.reviewerKeyId,
    ],
    [EDITION, 3, 0, REVIEWER.keyId],
  );
  assert.equal(PAYLOAD.contentDigest, contentDigest(PAYLOAD.publication));
  assert.deepEqual(PAYLOAD.source, {
    reservationId: `gh-${RUN_ID}-1`,
    researchRunId: "run-1a2b3c4d",
    workflowRunId: RUN_ID,
    runAttempt: 1,
    artifactId: ARTIFACT_ID,
    bundleDigest: LEDGER.sealed.digest,
  });
  assert.deepEqual(PAYLOAD.preview, {
    workflowRunId: 9200000001,
    runAttempt: 1,
  });
  assert.equal(
    previewArtifactName(EDITION, 9200000001, 1),
    "tech-brief-preview-2026-10-24-9200000001-1",
  );
  assert.notEqual(
    previewArtifactName(EDITION, RUN_ID, 1),
    bundleArtifactName(EDITION, RUN_ID, 1),
  );
  // Headlines, summaries, why-it-matters text, categories and links in both languages.
  const text = renderPreview(PAYLOAD);
  for (const s of STORIES) {
    for (const lang of ["en", "fr"])
      for (const field of ["headline", "summary", "whyItMatters"])
        assert.ok(text.includes(s[lang][field]), `${lang}.${field}`);
    assert.ok(text.includes(s.url));
    assert.ok(text.includes(`[${s.category}]`));
  }
  assert.ok(text.includes(`Edition: ${EDITION}`));
  assert.ok(text.includes(PAYLOAD.contentDigest));

  // Read-only: the content folder and the ledger are unchanged.
  const contentDir = contentCopy();
  const content = snapshot(contentDir);
  const ledger = readFileSync(LEDGER.path, "utf8");
  const again = await preview({ contentDir });
  assert.equal(again.status, "checked");
  assert.deepEqual(snapshot(contentDir), content);
  assert.equal(readFileSync(LEDGER.path, "utf8"), ledger);
  // The same research result previews to the same content digest.
  assert.equal(
    openPreview(again.sealed.bytes, REVIEWER_PRIVATE).contentDigest,
    PAYLOAD.contentDigest,
  );
});

test("preview makes no network or OpenAI calls", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("network is not allowed in the preview");
  };
  try {
    assert.equal((await preview()).status, "checked");
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0);
  // The preview path never loads the OpenAI client's key.
  assert.ok(!readFileSync(PREVIEW, "utf8").includes("OPENAI"));
});

test("preview enforces the real publication window: not before Sunday 20:00 Eastern, not after the next cutoff", async () => {
  for (const [name, now] of [
    ["Saturday evening", new Date("2026-10-25T01:00:00.000Z")],
    ["Sunday 19:59 EDT", new Date("2026-10-25T23:59:00.000Z")],
    ["after the next Saturday cutoff", new Date("2026-11-01T01:00:00.000Z")],
  ])
    assert.equal(await codeOf(() => preview({ now })), "NOT_DUE", name);
  assert.equal(
    (await preview({ now: new Date("2026-10-26T00:00:00.000Z") })).status,
    "checked",
  );
});

test("preview refuses a missing or invalid reviewer key before decrypting anything", async () => {
  for (const [key, code] of [
    ["", "REVIEWER_KEY_MISSING"],
    [null, "REVIEWER_KEY_MISSING"],
    ["MCowBQYDK2VuAyEA", "REVIEWER_KEY_INVALID"],
    [STRANGER.privateKeyPem, "REVIEWER_KEY_INVALID"],
  ])
    // With a wrong artifact key too: the reviewer key is checked first.
    assert.equal(
      await codeOf(() =>
        preview({ keys: [OTHER_KEY] }, { reviewerPublicKey: key }),
      ),
      code,
    );
});

test("preview refuses integrity, provenance and decryption failures", async () => {
  const flipped = Buffer.from(LEDGER.sealed.bytes);
  flipped[flipped.length - 5] ^= 1;
  const cases = [
    ["tampered bundle", { bytes: flipped }, "DIGEST_MISMATCH"],
    [
      "truncated bundle",
      { bytes: LEDGER.sealed.bytes.subarray(0, 100) },
      "DIGEST_MISMATCH",
    ],
    [
      "expired artifact",
      { recs: records({ artifact: { expired: true } }) },
      "ARTIFACT_EXPIRED",
    ],
    [
      "another artifact",
      { recs: records({ artifact: { id: ARTIFACT_ID + 1 } }) },
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
    ["wrong artifact key", { keys: [OTHER_KEY] }, "KEY_MISMATCH"],
    ["the rehearsal key", { keys: [KEY, REHEARSAL_KEY] }, "REHEARSAL_KEY"],
    [
      "no handoff",
      { edition: "2026-10-31", now: rehearsalClock("2026-10-31") },
      "NO_HANDOFF",
    ],
    ["sources gone on Sunday", { pages: new Map() }, "INSUFFICIENT_STORIES"],
  ];
  for (const [name, change, code] of cases)
    assert.equal(await codeOf(() => preview(change)), code, name);
});

// --- Approval binding ------------------------------------------------------------------------

test("publication after a preview: supervised mode needs the approved digest and writes exactly that content", async () => {
  assert.equal(approvalRequired("manual"), true);
  assert.equal(approvalRequired("enabled"), false);
  for (const other of [undefined, "", "off", "Enabled", "MANUAL"])
    assert.equal(approvalRequired(other), true, String(other));

  const publish = (contentDir, args) =>
    sundayPrepare({ ...inputs({ contentDir }), trigger: "manual", ...args });
  const refused = contentCopy();
  const before = snapshot(refused);
  for (const [args, code] of [
    [{ requireApproval: true }, "APPROVAL_REQUIRED"],
    [
      { requireApproval: true, approvedDigest: "f".repeat(64) },
      "APPROVAL_MISMATCH",
    ],
    [
      { requireApproval: true, approvedDigest: "not-a-digest" },
      "APPROVAL_INVALID",
    ],
  ])
    assert.equal(await codeOf(() => publish(refused, args)), code);
  assert.deepEqual(snapshot(refused), before);

  const dir = contentCopy();
  const outcome = await publish(dir, {
    requireApproval: true,
    approvedDigest: PAYLOAD.contentDigest,
  });
  assert.equal(outcome.status, "prepared");
  assert.equal(
    readFileSync(join(dir, "latest.json"), "utf8"),
    PAYLOAD.publication,
  );
  // The commit step checks the files again.
  assert.equal(
    checkApprovedFiles({
      contentDir: dir,
      edition: EDITION,
      approvedDigest: PAYLOAD.contentDigest,
      requireApproval: true,
    }),
    PAYLOAD.contentDigest,
  );
  assert.throws(
    () =>
      checkApprovedFiles({
        contentDir: dir,
        edition: EDITION,
        requireApproval: true,
      }),
    { code: "APPROVAL_REQUIRED" },
  );
  assert.throws(
    () =>
      checkApprovedFiles({
        contentDir: dir,
        edition: EDITION,
        approvedDigest: "f".repeat(64),
      }),
    { code: "APPROVAL_MISMATCH" },
  );
  writeFileSync(join(dir, "latest.json"), `${PAYLOAD.publication} `);
  assert.throws(
    () =>
      checkApprovedFiles({
        contentDir: dir,
        edition: EDITION,
        approvedDigest: PAYLOAD.contentDigest,
      }),
    { code: "APPROVAL_MISMATCH" },
  );
  // Automated mode: no approval needed and none checked.
  assert.equal(checkApprovedFiles({ contentDir: dir, edition: EDITION }), null);
  const automated = contentCopy();
  assert.equal(
    (
      await sundayPrepare({
        ...inputs({ contentDir: automated }),
        trigger: "schedule",
      })
    ).status,
    "prepared",
  );
});

test("editorial corrections through the Sunday wiring: bound to the ledger handoff, previewed, then published only as approved", async () => {
  const story = STORIES[2];
  const research = LEDGER.research.draft.stories[2];
  const corrections = (basis = {}) =>
    JSON.stringify({
      format: "ourfaces-tech-brief-corrections/1",
      edition: EDITION,
      basis: {
        researchRunId: "run-1a2b3c4d",
        workflowRunId: RUN_ID,
        runAttempt: 1,
        artifactId: ARTIFACT_ID,
        bundleDigest: LEDGER.sealed.digest,
        originalDigest: PAYLOAD.contentDigest,
        ...basis,
      },
      corrections: [
        {
          storyId: story.id,
          action: "revise",
          reasons: ["WHY_IT_MATTERS"],
          note: "Say who benefits.",
          evidence: [
            { url: story.url, quote: research.evidence.verification[1].quote },
          ],
          text: {
            en: {
              whyItMatters:
                "Developers working in large monorepos can rerun checks after small edits up to four times faster, which shortens local feedback.",
            },
            fr: {
              whyItMatters:
                "Les développeurs qui travaillent dans de grands monodépôts peuvent relancer les vérifications après de petites modifications jusqu’à quatre fois plus vite, ce qui raccourcit le retour en local.",
            },
          },
        },
      ],
    });
  const text = corrections();
  const corrected = await previewSunday({
    ...inputs(),
    reviewerPublicKey: REVIEWER.publicKey,
    previewRun: { workflowRunId: 9200000002, runAttempt: 1 },
    corrections: text,
  });
  assert.equal(corrected.status, "checked");
  assert.deepEqual(corrected.corrections.revised, [story.id]);
  const payload = openPreview(corrected.sealed.bytes, REVIEWER_PRIVATE);
  assert.equal(payload.corrections.originalDigest, PAYLOAD.contentDigest);
  assert.equal(
    payload.corrections.correctionsDigest,
    createHash("sha256").update(text).digest("hex"),
  );
  assert.notEqual(payload.contentDigest, PAYLOAD.contentDigest);
  // The uncorrected preview is unchanged by any of this.
  assert.equal(PAYLOAD.corrections, null);

  // A document for another bundle (same edition) is refused before anything is used.
  assert.equal(
    await codeOf(() =>
      previewSunday({
        ...inputs(),
        reviewerPublicKey: REVIEWER.publicKey,
        corrections: corrections({ bundleDigest: "0".repeat(64) }),
      }),
    ),
    "CORRECTION_BASIS",
  );
  // Publication: corrections need the corrected digest, even in automated mode.
  const publish = (args) =>
    sundayPrepare({
      ...inputs({ contentDir: contentCopy() }),
      trigger: "manual",
      corrections: text,
      ...args,
    });
  assert.equal(await codeOf(() => publish({})), "APPROVAL_REQUIRED");
  assert.equal(
    await codeOf(() =>
      publish({ approvedDigest: PAYLOAD.contentDigest, requireApproval: true }),
    ),
    "APPROVAL_MISMATCH",
  );
  const dir = contentCopy();
  const outcome = await sundayPrepare({
    ...inputs({ contentDir: dir }),
    trigger: "manual",
    corrections: text,
    approvedDigest: payload.contentDigest,
    requireApproval: true,
  });
  assert.equal(outcome.status, "prepared");
  assert.equal(
    readFileSync(join(dir, "latest.json"), "utf8"),
    payload.publication,
  );
  assert.equal(
    checkApprovedFiles({
      contentDir: dir,
      edition: EDITION,
      approvedDigest: payload.contentDigest,
      requireApproval: true,
    }),
    payload.contentDigest,
  );
  // The sealed research bundle is never rewritten.
  assert.equal(
    createHash("sha256").update(LEDGER.sealed.bytes).digest("hex"),
    LEDGER.sealed.digest,
  );
});

// --- CLI -------------------------------------------------------------------------------------

const clean = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !/^(GITHUB_|TECH_BRIEF_|OPENAI_)/.test(k),
  ),
);
const run = (script, args, env = {}) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { ...clean, ...env },
    encoding: "utf8",
  });
  return {
    status: result.status,
    json: JSON.parse(result.stdout),
    stdout: result.stdout,
  };
};

test("insideRepository resolves relative, missing and differently cased paths", () => {
  assert.equal(insideRepository(REPOSITORY), true);
  assert.equal(
    insideRepository(join(REPOSITORY, "scripts", "no-such-folder", "x")),
    true,
  );
  assert.equal(insideRepository(join(REPOSITORY, "..", "elsewhere")), false);
  assert.equal(insideRepository(tmpdir()), false);
  if (process.platform === "win32")
    assert.equal(insideRepository(REPOSITORY.toUpperCase()), true);
});

test("CLI keygen, public-key and open work outside the repository only and print no content", () => {
  const dir = temp("cli");
  const keyFile = join(dir, "keys", "reviewer.pem");
  // Never inside the repository, and nothing is created there.
  const inside = join(
    REPOSITORY,
    "scripts",
    "tech-brief",
    "test",
    ".reviewer-test.pem",
  );
  const refused = run(PREVIEW, ["keygen", "--out", inside]);
  assert.deepEqual(
    [refused.status, refused.json.code],
    [4, "INSIDE_REPOSITORY"],
  );
  assert.ok(!existsSync(inside));

  const made = run(PREVIEW, ["keygen", "--out", keyFile]);
  assert.equal(made.status, 0);
  assert.match(readFileSync(keyFile, "utf8"), /^-----BEGIN PRIVATE KEY-----/);
  assert.ok(!made.stdout.includes("PRIVATE KEY"));
  const publicKey = parseReviewerPublicKey(made.json.publicKey);
  assert.equal(made.json.keyId, reviewerKeyId(publicKey));
  assert.equal(
    run(PREVIEW, ["keygen", "--out", keyFile]).json.code,
    "OUTPUT_EXISTS",
  );
  assert.deepEqual(run(PREVIEW, ["public-key", "--key", keyFile]).json, {
    ok: true,
    command: "public-key",
    publicKey: made.json.publicKey,
    keyId: made.json.keyId,
  });

  // A preview for this key, downloaded as a folder holding one file.
  const sealed = sealPreview({ payload: PAYLOAD, recipient: publicKey });
  const download = join(dir, "download");
  mkdirSync(download);
  writeFileSync(join(download, PREVIEW_FILE), sealed.bytes);
  const intoRepo = run(PREVIEW, [
    "open",
    "--in",
    download,
    "--key",
    keyFile,
    "--out",
    join(REPOSITORY, ".preview-test"),
  ]);
  assert.deepEqual(
    [intoRepo.status, intoRepo.json.code],
    [4, "INSIDE_REPOSITORY"],
  );
  assert.ok(!existsSync(join(REPOSITORY, ".preview-test")));
  const wrongKey = join(dir, "stranger.pem");
  writeFileSync(wrongKey, STRANGER.privateKeyPem);
  assert.equal(
    run(PREVIEW, [
      "open",
      "--in",
      download,
      "--key",
      wrongKey,
      "--out",
      join(dir, "x"),
    ]).json.code,
    "REVIEWER_KEY_MISMATCH",
  );
  assert.ok(!existsSync(join(dir, "x")));

  const out = join(dir, "review");
  const opened = run(PREVIEW, [
    "open",
    "--in",
    download,
    "--key",
    keyFile,
    "--out",
    out,
  ]);
  assert.equal(opened.status, 0);
  assert.deepEqual(
    [
      opened.json.edition,
      opened.json.stories,
      opened.json.dropped,
      opened.json.contentDigest,
    ],
    [EDITION, 3, 0, PAYLOAD.contentDigest],
  );
  for (const s of STORIES)
    assert.ok(
      !opened.stdout.includes(s.en.headline) &&
        !opened.stdout.includes(s.fr.headline),
    );
  assert.equal(
    readFileSync(join(out, "latest.json"), "utf8"),
    PAYLOAD.publication,
  );
  assert.equal(
    contentDigest(readFileSync(join(out, "latest.json"), "utf8")),
    PAYLOAD.contentDigest,
  );
  assert.ok(
    readFileSync(
      join(out, `editorial-preview-${EDITION}.txt`),
      "utf8",
    ).includes(STORIES[0].fr.headline),
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(out, `editorial-preview-${EDITION}.json`), "utf8"),
    ),
    PAYLOAD,
  );
  // Nothing is overwritten.
  assert.equal(
    run(PREVIEW, ["open", "--in", download, "--key", keyFile, "--out", out])
      .json.code,
    "OUTPUT_EXISTS",
  );
  assert.equal(run(PREVIEW, ["nope"]).status, 1);
});

test("CLI preview: no reviewer key, no decryption, no output, no content in the log", () => {
  const dir = temp("cli-preview");
  for (const [env, code] of [
    [{}, "REVIEWER_KEY_MISSING"],
    [{ TECH_BRIEF_REVIEWER_PUBLIC_KEY: "invalid" }, "REVIEWER_KEY_INVALID"],
  ]) {
    const result = run(
      AUTOMATION,
      [
        "preview",
        "--ledger-dir",
        dir,
        "--edition",
        EDITION,
        "--out-dir",
        join(dir, "preview"),
      ],
      { TECH_BRIEF_ARTIFACT_KEY: KEY.toString("base64"), ...env },
    );
    assert.deepEqual([result.status, result.json.code], [4, code]);
    assert.ok(!existsSync(join(dir, "preview")));
  }
});
