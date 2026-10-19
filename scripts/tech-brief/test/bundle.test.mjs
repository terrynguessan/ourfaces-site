// Phase 4 research bundles: AES-256-GCM sealing, digest and authentication
// checks, run binding, report/draft pairing, key handling and the CLI.
// Synthetic data and test-only keys; nothing leaves the machine.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  existsSync,
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
  BundleError,
  MAX_BUNDLE_BYTES,
  MAX_PAYLOAD_BYTES,
  bundleDigest,
  checkResearchPair,
  keyId,
  openBundle,
  parseKey,
  sealBundle,
} from "../bundle.mjs";
import { fixtureJson } from "./helpers.mjs";

// Test-only keys: derived from fixed strings, never used anywhere else.
const KEY_A = createHash("sha256")
  .update("ourfaces test-only bundle key A")
  .digest();
const KEY_B = createHash("sha256")
  .update("ourfaces test-only bundle key B")
  .digest();
const WORKFLOW =
  "owner/repo/.github/workflows/tech-brief-research.yml@refs/heads/main";
const RUN_ID = "run-1a2b3c4d";
const QUOTE = "SYNTHETIC VERIFICATION QUOTE";
const CLI = fileURLToPath(new URL("../bundle.mjs", import.meta.url));

/** A synthetic successful research result shaped like research.mjs output. */
function pair({ mode = "production", runId = RUN_ID } = {}) {
  const draft = fixtureJson("valid-edition.json");
  draft.generation = {
    runId,
    mode,
    policyStatus: "approved",
    provisionalPolicyOverride: false,
    models: { writing: "model-x" },
    estimatedCostUsd: 0.191048,
  };
  const report = {
    schema: "ourfaces-tech-brief-research-report/1",
    runId,
    mode,
    edition: draft.edition,
    status: "edition",
    reason: null,
    candidates: [
      ...draft.stories.map((s, i) => ({
        key: `k${i + 1}`,
        url: s.url,
        status: "selected",
        storyId: s.id,
        verification: { claims: [{ quote: `${QUOTE} ${i}` }] },
      })),
      {
        key: "k9",
        url: "https://other.fixture.ourfaces.net/x",
        status: "dropped",
        reason: "NOT_SELECTED",
      },
    ],
    selected: draft.stories.map((s, i) => `k${i + 1}`),
    validation: { ok: true, errors: [], warnings: [] },
    budget: { runTotalCountedUsd: 0.191048 },
  };
  return { report, draft };
}
const expected = (overrides = {}) => ({
  edition: "2026-10-24",
  runId: RUN_ID,
  workflow: WORKFLOW,
  mode: "production",
  ...overrides,
});
const seal = (p = pair(), key = KEY_A) =>
  sealBundle({ ...p, workflow: WORKFLOW, key });
const open = (
  bytes,
  { digest = bundleDigest(bytes), keys = [KEY_A], exp = expected() } = {},
) => openBundle(bytes, { digest, expected: exp, keys });
const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof BundleError) return error.code;
    throw error;
  }
  return "NO_ERROR";
};
// Layout helpers (magic 8 + version 1 + header length 2).
const headerEnd = (bytes) => 11 + bytes.readUInt16BE(9);
const ciphertextStart = (bytes) => headerEnd(bytes) + 12;
const flip = (bytes, at) => {
  const copy = Buffer.from(bytes);
  copy[at] ^= 0x01;
  return copy;
};
/** Rewrites the header text (same framing) to simulate a relabelled bundle. */
function withHeader(bytes, change) {
  const header = JSON.parse(
    bytes.subarray(11, headerEnd(bytes)).toString("utf8"),
  );
  const text = Buffer.from(JSON.stringify(change(header)), "utf8");
  const prefix = Buffer.from(bytes.subarray(0, 11));
  prefix.writeUInt16BE(text.length, 9);
  return Buffer.concat([prefix, text, bytes.subarray(headerEnd(bytes))]);
}
/** Seals an arbitrary payload in the version 1 format (for authenticated-but-wrong payloads). */
function sealRaw(header, payloadText, key = KEY_A) {
  const fields = [
    "format",
    "version",
    "edition",
    "runId",
    "workflow",
    "mode",
    "keyId",
    "createdAt",
    "payloadBytes",
  ];
  const payload = Buffer.from(payloadText, "utf8");
  const full = {
    format: "ourfaces-tech-brief-bundle",
    version: 1,
    edition: "2026-10-24",
    runId: RUN_ID,
    workflow: WORKFLOW,
    mode: "production",
    keyId: keyId(key),
    createdAt: "2026-10-25T00:30:00.000Z",
    payloadBytes: payload.length,
    ...header,
  };
  const headerBytes = Buffer.from(
    JSON.stringify(Object.fromEntries(fields.map((k) => [k, full[k]]))),
    "utf8",
  );
  const prefix = Buffer.alloc(11);
  Buffer.from("OFTBUNDL").copy(prefix);
  prefix.writeUInt8(1, 8);
  prefix.writeUInt16BE(headerBytes.length, 9);
  const iv = randomBytes(12);
  const aad = Buffer.concat([prefix, headerBytes, iv]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([aad, ct, cipher.getAuthTag()]);
}
const payloadOf = (p, extra = {}) =>
  JSON.stringify({
    format: "ourfaces-tech-brief-bundle-payload/1",
    edition: p.report.edition,
    runId: p.report.runId,
    mode: p.report.mode,
    workflow: WORKFLOW,
    report: p.report,
    draft: p.draft,
    ...extra,
  });

test("seal and open: the report and draft travel together and come back unchanged", () => {
  const p = pair();
  const sealed = seal(p);
  assert.equal(sealed.digest, bundleDigest(sealed.bytes));
  assert.match(sealed.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    (({ edition, runId, workflow, mode, keyId: id, version }) => ({
      edition,
      runId,
      workflow,
      mode,
      id,
      version,
    }))(sealed.header),
    {
      edition: "2026-10-24",
      runId: RUN_ID,
      workflow: WORKFLOW,
      mode: "production",
      id: keyId(KEY_A),
      version: 1,
    },
  );
  const opened = open(sealed.bytes);
  assert.deepEqual(opened.report, p.report);
  assert.deepEqual(opened.draft, p.draft);
  // Nothing readable from the stories, quotes or report is in the file.
  const raw = sealed.bytes.toString("latin1");
  for (const secret of [
    QUOTE,
    p.draft.stories[0].en.headline,
    p.draft.stories[0].fr.summary.slice(0, 30),
    "fixture.ourfaces.net",
    "validation",
  ])
    assert.ok(!raw.includes(secret), secret);
});

test("every seal uses a fresh IV: identical input gives different ciphertext and digests", () => {
  const p = pair();
  const ivs = new Set();
  const digests = new Set();
  for (let i = 0; i < 100; i++) {
    const { bytes, digest } = seal(p);
    ivs.add(
      bytes.subarray(headerEnd(bytes), ciphertextStart(bytes)).toString("hex"),
    );
    digests.add(digest);
  }
  assert.equal(ivs.size, 100);
  assert.equal(digests.size, 100);
  const one = seal(p);
  const two = seal(p);
  assert.notDeepEqual(
    one.bytes.subarray(ciphertextStart(one.bytes)),
    two.bytes.subarray(ciphertextStart(two.bytes)),
  );
  assert.deepEqual(open(one.bytes).draft, open(two.bytes).draft);
});

test("report/draft pairing: only one successful run's consistent output can be sealed", () => {
  assert.deepEqual(checkResearchPair(pair().report, pair().draft), {
    edition: "2026-10-24",
    runId: RUN_ID,
    mode: "production",
  });
  const cases = {
    "not an edition run": (p) => (p.report.status = "no-edition"),
    "report schema": (p) => (p.report.schema = "other/1"),
    "failed validation": (p) => (p.report.validation.ok = false),
    "missing validation": (p) => delete p.report.validation,
    "missing report runId": (p) => delete p.report.runId,
    "different run": (p) => (p.draft.generation.runId = "run-ffffffff"),
    "different edition": (p) => (p.report.edition = "2026-10-31"),
    "different mode": (p) => (p.draft.generation.mode = "dry-run"),
    "different cost": (p) => (p.draft.generation.estimatedCostUsd = 0.2),
    "missing generation": (p) => delete p.draft.generation,
    "wrong publishedOn": (p) => (p.draft.publishedOn = "2026-10-26"),
    "draft schema (missing French)": (p) => delete p.draft.stories[1].fr,
    "selected order differs": (p) => p.report.selected.reverse(),
    "selected count differs": (p) => p.report.selected.pop(),
    "story URL differs": (p) =>
      (p.report.candidates[2].url = "https://elsewhere.fixture.ourfaces.net/a"),
    "storyId differs": (p) => (p.report.candidates[0].storyId = "s9"),
    "candidate not selected": (p) =>
      (p.report.candidates[0].status = "dropped"),
    "duplicate candidate key": (p) =>
      p.report.candidates.push({ ...p.report.candidates[0] }),
    "report not an object": (p) => (p.report = null),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const p = pair();
    mutate(p);
    assert.equal(
      codeOf(() => checkResearchPair(p.report, p.draft)),
      "INCONSISTENT",
      name,
    );
    assert.equal(
      codeOf(() => seal(p)),
      "INCONSISTENT",
      `${name}: not sealed`,
    );
  }
});

test("a changed byte anywhere fails: the digest first, then authentication even with a recomputed digest", () => {
  const { bytes, digest } = seal();
  const positions = {
    header: 20,
    iv: headerEnd(bytes) + 3,
    ciphertext: ciphertextStart(bytes) + 50,
    tag: bytes.length - 5,
  };
  for (const [part, at] of Object.entries(positions)) {
    const tampered = flip(bytes, at);
    assert.equal(
      codeOf(() => open(tampered, { digest })),
      "DIGEST_MISMATCH",
      part,
    );
    const code = codeOf(() => open(tampered));
    assert.ok(
      ["AUTHENTICATION_FAILED", "MALFORMED"].includes(code),
      `${part}: ${code}`,
    );
  }
  assert.equal(
    codeOf(() => open(flip(bytes, positions.ciphertext))),
    "AUTHENTICATION_FAILED",
  );
  assert.equal(
    codeOf(() => open(flip(bytes, positions.tag))),
    "AUTHENTICATION_FAILED",
  );
  assert.equal(
    codeOf(() => open(flip(bytes, positions.iv))),
    "AUTHENTICATION_FAILED",
  );
});

test("relabelled metadata is caught by authentication, even when the expectation matches the new label", () => {
  const { bytes } = seal();
  const relabels = {
    edition: (h) => ({ ...h, edition: "2026-10-31" }),
    runId: (h) => ({ ...h, runId: "run-ffffffff" }),
    workflow: (h) => ({
      ...h,
      workflow: "owner/repo/.github/workflows/other.yml@refs/heads/main",
    }),
    mode: (h) => ({ ...h, mode: "dry-run" }),
    createdAt: (h) => ({ ...h, createdAt: "2026-10-26T00:00:00.000Z" }),
  };
  for (const [field, change] of Object.entries(relabels)) {
    const relabelled = withHeader(bytes, change);
    const header = JSON.parse(
      relabelled.subarray(11, headerEnd(relabelled)).toString("utf8"),
    );
    assert.equal(
      codeOf(() =>
        open(relabelled, {
          exp: expected({
            edition: header.edition,
            runId: header.runId,
            workflow: header.workflow,
            mode: header.mode,
          }),
        }),
      ),
      "AUTHENTICATION_FAILED",
      field,
    );
  }
  // A header that is not canonical or not valid never reaches decryption.
  assert.equal(
    codeOf(() => open(withHeader(bytes, (h) => ({ extra: 1, ...h })))),
    "MALFORMED",
  );
  assert.equal(
    codeOf(() =>
      open(withHeader(bytes, (h) => ({ ...h, edition: "2026-10-25" }))),
    ),
    "MALFORMED",
  );
  assert.equal(
    codeOf(() =>
      open(
        withHeader(bytes, (h) => ({ ...h, payloadBytes: h.payloadBytes - 1 })),
      ),
    ),
    "MALFORMED",
  );
});

test("keys: wrong key refused, a forged key id still fails authentication, rotation accepts the previous key", () => {
  const { bytes } = seal();
  assert.equal(
    codeOf(() => open(bytes, { keys: [KEY_B] })),
    "KEY_MISMATCH",
  );
  const forged = withHeader(bytes, (h) => ({ ...h, keyId: keyId(KEY_B) }));
  assert.equal(
    codeOf(() => open(forged, { keys: [KEY_B] })),
    "AUTHENTICATION_FAILED",
  );
  assert.equal(open(bytes, { keys: [KEY_B, KEY_A] }).draft.stories.length, 4);
  assert.notEqual(keyId(KEY_A), keyId(KEY_B));
  assert.ok(
    !sealBundle({ ...pair(), workflow: WORKFLOW, key: KEY_A }).bytes.includes(
      KEY_A,
    ),
  );
});

test("binding: a genuine bundle for another edition, run, workflow or mode is refused", () => {
  const { bytes } = seal();
  for (const [field, value, code] of [
    ["edition", "2026-10-31", "EDITION_MISMATCH"],
    ["runId", "run-ffffffff", "RUN_MISMATCH"],
    [
      "workflow",
      "owner/repo/.github/workflows/other.yml@refs/heads/main",
      "WORKFLOW_MISMATCH",
    ],
    ["mode", "dry-run", "MODE_MISMATCH"],
  ])
    assert.equal(
      codeOf(() => open(bytes, { exp: expected({ [field]: value }) })),
      code,
      field,
    );
  // A dry-run result cannot be opened as a production one.
  const dry = seal(pair({ mode: "dry-run" }));
  assert.equal(
    codeOf(() => open(dry.bytes)),
    "MODE_MISMATCH",
  );
  assert.equal(
    open(dry.bytes, { exp: expected({ mode: "dry-run" }) }).report.mode,
    "dry-run",
  );
});

test("authenticated but inconsistent payloads are refused", () => {
  const p = pair();
  assert.equal(
    open(sealRaw({}, payloadOf(p))).draft.stories.length,
    4,
    "the raw sealer matches the format",
  );
  const cases = {
    "payload edition differs from header": payloadOf(p, {
      edition: "2026-10-31",
    }),
    "payload run differs from header": payloadOf(p, { runId: "run-ffffffff" }),
    "payload workflow differs from header": payloadOf(p, {
      workflow: "owner/repo/.github/workflows/x.yml@refs/heads/main",
    }),
    "payload format": payloadOf(p, { format: "other/1" }),
    "not JSON": "not json at all",
    "report/draft mismatch": payloadOf({
      report: { ...p.report, selected: [...p.report.selected].reverse() },
      draft: p.draft,
    }),
    "missing draft": payloadOf({ report: p.report, draft: undefined }),
  };
  for (const [name, text] of Object.entries(cases))
    assert.equal(
      codeOf(() => open(sealRaw({}, text))),
      "INCONSISTENT",
      name,
    );
  // Header and payload both relabelled to another run, but the report inside is still the original run's.
  const other = sealRaw(
    { runId: "run-ffffffff" },
    payloadOf(p, { runId: "run-ffffffff" }),
  );
  assert.equal(
    codeOf(() => open(other, { exp: expected({ runId: "run-ffffffff" }) })),
    "INCONSISTENT",
  );
});

test("unsupported versions, truncated, extended and malformed input are refused", () => {
  const { bytes } = seal();
  const v2 = Buffer.from(bytes);
  v2[8] = 2;
  assert.equal(
    codeOf(() => open(v2)),
    "UNSUPPORTED_VERSION",
  );
  assert.equal(
    codeOf(() => open(withHeader(bytes, (h) => ({ ...h, version: 2 })))),
    "MALFORMED",
  );
  const badMagic = Buffer.from(bytes);
  badMagic[0] = 0x41;
  const lengthZero = Buffer.from(bytes);
  lengthZero.writeUInt16BE(0, 9);
  const lengthHuge = Buffer.from(bytes);
  lengthHuge.writeUInt16BE(60000, 9);
  const cases = {
    empty: Buffer.alloc(0),
    "bad magic": badMagic,
    "truncated by one byte": bytes.subarray(0, bytes.length - 1),
    "truncated to the header": bytes.subarray(0, headerEnd(bytes)),
    "extended by one byte": Buffer.concat([bytes, Buffer.from([0])]),
    "header length 0": lengthZero,
    "header length too large": lengthHuge,
    "header not JSON": Buffer.concat([
      bytes.subarray(0, 11),
      Buffer.from("x".repeat(bytes.readUInt16BE(9))),
      bytes.subarray(headerEnd(bytes)),
    ]),
  };
  for (const [name, input] of Object.entries(cases))
    assert.equal(
      codeOf(() => open(input)),
      "MALFORMED",
      name,
    );
  assert.equal(
    codeOf(() =>
      openBundle("not bytes", {
        digest: "0".repeat(64),
        expected: expected(),
        keys: [KEY_A],
      }),
    ),
    "MALFORMED",
  );
  const huge = Buffer.alloc(MAX_BUNDLE_BYTES + 1);
  assert.equal(
    codeOf(() => open(huge, { digest: "0".repeat(64) })),
    "OVERSIZED",
  );
});

test("missing or invalid keys, digests and expectations are refused without echoing the key", () => {
  const good = KEY_A.toString("base64");
  assert.deepEqual(parseKey(good), KEY_A);
  for (const [input, code] of [
    [undefined, "KEY_MISSING"],
    ["", "KEY_MISSING"],
    ["c2hvcnQ=", "KEY_INVALID"],
    [KEY_A.toString("hex"), "KEY_INVALID"],
    [randomBytes(31).toString("base64"), "KEY_INVALID"],
    [` ${good}`, "KEY_INVALID"],
    [`${good}\n`, "KEY_INVALID"],
    [good.replace(/=$/, ""), "KEY_INVALID"],
    [KEY_A.toString("base64url"), "KEY_INVALID"],
  ]) {
    let error;
    try {
      parseKey(input);
    } catch (e) {
      error = e;
    }
    assert.equal(error?.code, code, String(input));
    assert.ok(!String(error.message).includes(good.slice(0, 12)));
  }
  assert.equal(
    codeOf(() =>
      sealBundle({ ...pair(), workflow: WORKFLOW, key: KEY_A.subarray(0, 16) }),
    ),
    "KEY_INVALID",
  );
  assert.equal(
    codeOf(() => sealBundle({ ...pair(), workflow: WORKFLOW, key: good })),
    "KEY_INVALID",
  );
  const { bytes, digest } = seal();
  assert.equal(
    codeOf(() => openBundle(bytes, { digest, expected: expected(), keys: [] })),
    "KEY_MISSING",
  );
  assert.equal(
    codeOf(() =>
      openBundle(bytes, { digest, expected: expected(), keys: [good] }),
    ),
    "KEY_INVALID",
  );
  assert.equal(
    codeOf(() => openBundle(bytes, { expected: expected(), keys: [KEY_A] })),
    "DIGEST_REQUIRED",
  );
  assert.equal(
    codeOf(() =>
      openBundle(bytes, { digest: "ABC", expected: expected(), keys: [KEY_A] }),
    ),
    "DIGEST_REQUIRED",
  );
  for (const field of ["edition", "runId", "workflow", "mode"]) {
    const exp = expected();
    delete exp[field];
    assert.equal(
      codeOf(() => openBundle(bytes, { digest, expected: exp, keys: [KEY_A] })),
      "EXPECTED_REQUIRED",
      field,
    );
  }
  assert.equal(
    codeOf(() =>
      sealBundle({ ...pair(), workflow: "not a workflow ref", key: KEY_A }),
    ),
    "INVALID_INPUT",
  );
});

test("oversized input is refused before anything is produced", () => {
  const p = pair();
  p.report.candidates[4].padding = "x".repeat(MAX_PAYLOAD_BYTES);
  assert.equal(
    codeOf(() => seal(p)),
    "OVERSIZED",
  );
});

test("no plaintext fallback: every failure throws, and no error carries story text, quotes or key material", () => {
  const p = pair();
  const { bytes, digest } = seal(p);
  const failures = [
    () => open(bytes, { keys: [KEY_B] }),
    () => open(flip(bytes, ciphertextStart(bytes) + 1)),
    () => open(flip(bytes, ciphertextStart(bytes) + 1), { digest }),
    () => open(bytes, { exp: expected({ runId: "run-ffffffff" }) }),
    () => open(sealRaw({}, payloadOf(p, { edition: "2026-10-31" }))),
    () =>
      open(
        withHeader(bytes, (h) => ({ ...h, edition: "2026-10-31" })),
        { exp: expected({ edition: "2026-10-31" }) },
      ),
  ];
  const forbidden = [
    QUOTE,
    p.draft.stories[0].en.headline,
    p.draft.stories[0].url,
    KEY_A.toString("base64"),
    KEY_A.toString("hex"),
  ];
  for (const failure of failures) {
    let result;
    let error;
    try {
      result = failure();
    } catch (e) {
      error = e;
    }
    assert.equal(result, undefined, "no content is returned on failure");
    assert.ok(error instanceof BundleError, String(error));
    const text = `${error.message} ${error.stack} ${JSON.stringify(error)}`;
    for (const value of forbidden)
      assert.ok(
        !text.includes(value),
        `${error.code} leaks ${value.slice(0, 20)}`,
      );
  }
});

test("CLI: seal writes one new file atomically and prints no content or key; verify reports identifiers only", () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-bundle-"));
  const p = pair();
  writeFileSync(join(dir, "report.json"), JSON.stringify(p.report));
  writeFileSync(join(dir, "draft-edition.json"), JSON.stringify(p.draft));
  const keyText = KEY_A.toString("base64");
  const cli = (args, env = { TECH_BRIEF_ARTIFACT_KEY: keyText }) => {
    const childEnv = { ...process.env };
    delete childEnv.TECH_BRIEF_ARTIFACT_KEY;
    delete childEnv.TECH_BRIEF_ARTIFACT_KEY_PREVIOUS;
    Object.assign(childEnv, env);
    try {
      const stdout = execFileSync(process.execPath, [CLI, ...args], {
        encoding: "utf8",
        env: childEnv,
        stdio: "pipe",
      });
      return { status: 0, stdout, json: JSON.parse(stdout) };
    } catch (error) {
      return {
        status: error.status,
        stdout: `${error.stdout}${error.stderr}`,
        json: JSON.parse(error.stdout),
      };
    }
  };
  const out = join(dir, "research-bundle.bin");
  const sealArgs = [
    "seal",
    "--report",
    join(dir, "report.json"),
    "--draft",
    join(dir, "draft-edition.json"),
    "--workflow",
    WORKFLOW,
    "--out",
    out,
  ];

  const noKey = cli(sealArgs, {});
  assert.deepEqual([noKey.status, noKey.json.code], [4, "KEY_MISSING"]);
  assert.ok(!existsSync(out));

  const sealed = cli(sealArgs);
  assert.equal(sealed.status, 0);
  assert.match(sealed.json.digest, /^[0-9a-f]{64}$/);
  assert.equal(sealed.json.digest, bundleDigest(readFileSync(out)));
  for (const leak of [keyText, QUOTE, p.draft.stories[0].en.headline])
    assert.ok(!sealed.stdout.includes(leak));

  const again = cli(sealArgs);
  assert.deepEqual([again.status, again.json.code], [4, "OUTPUT_EXISTS"]);
  assert.deepEqual(
    readdirSync(dir).sort(),
    ["draft-edition.json", "report.json", "research-bundle.bin"],
    "no temporary files left",
  );

  const verifyArgs = (digest, runId = RUN_ID) => [
    "verify",
    "--in",
    out,
    "--digest",
    digest,
    "--edition",
    "2026-10-24",
    "--run-id",
    runId,
    "--workflow",
    WORKFLOW,
    "--mode",
    "production",
  ];
  const verified = cli(verifyArgs(sealed.json.digest));
  assert.equal(verified.status, 0);
  assert.deepEqual(
    (({ edition, runId, mode, stories }) => ({
      edition,
      runId,
      mode,
      stories,
    }))(verified.json),
    { edition: "2026-10-24", runId: RUN_ID, mode: "production", stories: 4 },
  );
  for (const leak of [
    keyText,
    QUOTE,
    p.draft.stories[0].en.headline,
    p.draft.stories[0].url,
  ])
    assert.ok(!verified.stdout.includes(leak));
  assert.equal(cli(verifyArgs("0".repeat(64))).json.code, "DIGEST_MISMATCH");
  assert.equal(
    cli(verifyArgs(sealed.json.digest, "run-ffffffff")).json.code,
    "RUN_MISMATCH",
  );
  assert.equal(
    cli(verifyArgs(sealed.json.digest), {
      TECH_BRIEF_ARTIFACT_KEY: KEY_B.toString("base64"),
    }).json.code,
    "KEY_MISMATCH",
  );
  assert.equal(
    cli(verifyArgs(sealed.json.digest), {
      TECH_BRIEF_ARTIFACT_KEY: KEY_B.toString("base64"),
      TECH_BRIEF_ARTIFACT_KEY_PREVIOUS: keyText,
    }).status,
    0,
    "rotation: the previous key still opens older bundles",
  );
  assert.equal(
    cli(verifyArgs(sealed.json.digest), {
      TECH_BRIEF_ARTIFACT_KEY: "not-a-key",
    }).json.code,
    "KEY_INVALID",
  );
  assert.equal(cli(["verify", "--in", out]).status, 1);
  assert.equal(cli(["unknown"]).status, 1);

  // An inconsistent pair is refused and nothing is written.
  writeFileSync(
    join(dir, "draft-edition.json"),
    JSON.stringify({ ...p.draft, edition: "2026-10-31" }),
  );
  const out2 = join(dir, "second.bin");
  const refused = cli([
    "seal",
    "--report",
    join(dir, "report.json"),
    "--draft",
    join(dir, "draft-edition.json"),
    "--workflow",
    WORKFLOW,
    "--out",
    out2,
  ]);
  assert.deepEqual([refused.status, refused.json.code], [4, "INCONSISTENT"]);
  assert.ok(!existsSync(out2));
  assert.equal(readdirSync(dir).filter((n) => n.includes(".tmp-")).length, 0);
});

// Optional: the pairing check accepts real research.mjs output
// (TECH_BRIEF_DRYRUN_DIR=<folder holding report.json and draft-edition.json>).
const realDir = process.env.TECH_BRIEF_DRYRUN_DIR;
test(
  "real research output pairs and round-trips",
  {
    skip:
      realDir && existsSync(join(realDir ?? "", "draft-edition.json"))
        ? false
        : "research output not provided",
  },
  () => {
    const report = JSON.parse(
      readFileSync(join(realDir, "report.json"), "utf8"),
    );
    const draft = JSON.parse(
      readFileSync(join(realDir, "draft-edition.json"), "utf8"),
    );
    const identity = checkResearchPair(report, draft);
    const { bytes } = sealBundle({
      report,
      draft,
      workflow: WORKFLOW,
      key: KEY_A,
    });
    const opened = open(bytes, { exp: { ...identity, workflow: WORKFLOW } });
    assert.deepEqual(opened.draft, draft);
  },
);
