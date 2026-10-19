// Phase 4: encrypted, authenticated research bundles.
//
// A bundle carries one successful research result (the full research report
// and the bilingual draft edition) from the Saturday research job to the
// Sunday publication job without exposing unpublished stories, verification
// quotations or the report: GitHub Actions artifacts of a public repository
// can be downloaded by others, so they must hold ciphertext only.
//
// Format (version 1), one binary file:
//   magic "OFTBUNDL" (8 bytes) | version (1 byte) | header length (uint16 BE)
//   | header (canonical JSON) | IV (12 random bytes) | ciphertext | GCM tag (16)
// - AES-256-GCM with a fresh random 96-bit IV per bundle. Everything before
//   the ciphertext (magic, version, header, IV) is additional authenticated
//   data, so the header cannot be changed without failing authentication.
// - The header names the edition, research run, intended workflow identity,
//   mode, key id and payload length. It is NOT trusted until the tag verifies;
//   the encrypted payload repeats edition, run, workflow and mode and must
//   agree with it.
// - SHA-256 of the whole file is the bundle digest. The research job records
//   it; the publication job must present it before decryption is attempted.
// - No plaintext fallback: any failure throws BundleError, and plaintext is
//   returned only after the tag has verified. Errors name fields, never
//   payload content or key material.
//
// Keys: 32 random bytes, supplied base64-encoded through environment variables
// (TECH_BRIEF_ARTIFACT_KEY, and TECH_BRIEF_ARTIFACT_KEY_PREVIOUS during a
// rotation), later from a GitHub Actions environment secret. Never in the
// repository or in logs. A key id (HMAC-derived, not reversible) in the header
// selects the key on decryption. Create a key locally with
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// and paste it into the secret; do not store it anywhere else. Rotation: seal
// with the new key and keep the previous one as *_PREVIOUS until every bundle
// sealed with it has expired (artifact retention). A lost key makes its
// bundles unreadable: those editions cannot be published and must be
// researched again within their recovery window.
//
// Integration contract (implemented here: seal, verify, open and the CLI;
// later workflow milestones implement the GitHub steps):
//  Saturday research job, after research.mjs reports status "edition":
//   1. `seal` checks the report/draft pairing, encrypts both into one bundle in
//      the runner's temporary directory and prints its digest.
//   2. The job records the digest with the ledger settlement handoff (future)
//      and uploads only the bundle file as an artifact with a short retention.
//   Sunday publication job:
//   3. Downloads the artifact of the recorded research run, then calls
//      openBundle in-process (or `verify` first) with the recorded digest, the
//      expected edition, run id, research workflow identity and mode.
//   4. Passes the returned report and draft to publication validation without
//      writing them to disk; any BundleError means no publication.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { isSaturdayDate } from "./schedule.mjs";
import { addDays, checkSchema } from "./validate.mjs";

export const BUNDLE_FORMAT = "ourfaces-tech-brief-bundle";
export const BUNDLE_VERSION = 1;
export const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAGIC = Buffer.from("OFTBUNDL", "ascii");
const MAX_HEADER_BYTES = 1024;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX_BYTES = MAGIC.length + 1 + 2;
export const MAX_BUNDLE_BYTES =
  PREFIX_BYTES + MAX_HEADER_BYTES + IV_BYTES + MAX_PAYLOAD_BYTES + TAG_BYTES;
const HEADER_FIELDS = [
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
const PAYLOAD_FORMAT = "ourfaces-tech-brief-bundle-payload/1";
const REPORT_SCHEMA = "ourfaces-tech-brief-research-report/1";
const RUN_ID = /^run-[0-9a-f]{8}$/;
// GitHub's workflow_ref form, e.g. owner/repo/.github/workflows/x.yml@refs/heads/main
const WORKFLOW = /^[A-Za-z0-9._/-]{1,200}@refs\/[A-Za-z0-9._/-]{1,100}$/;
const MODES = ["dry-run", "production"];
const KEY_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

export class BundleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BundleError";
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new BundleError(code, message);
};

/** A 32-byte key from its base64 form. The key is never echoed in errors. */
export function parseKey(text) {
  if (typeof text !== "string" || text.length === 0)
    fail("KEY_MISSING", "No artifact key was supplied");
  if (!KEY_BASE64.test(text))
    fail("KEY_INVALID", "The artifact key must be 32 bytes, base64-encoded");
  const key = Buffer.from(text, "base64");
  if (key.length !== 32 || key.toString("base64") !== text)
    fail("KEY_INVALID", "The artifact key must be 32 bytes, base64-encoded");
  return key;
}

/** Non-reversible key identifier for key selection and rotation. */
export function keyId(key) {
  return createHmac("sha256", key)
    .update("ourfaces-tech-brief-bundle key id")
    .digest("hex")
    .slice(0, 16);
}

export const bundleDigest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

const canonical = (header) =>
  JSON.stringify(Object.fromEntries(HEADER_FIELDS.map((k) => [k, header[k]])));

function headerProblem(h) {
  if (h.format !== BUNDLE_FORMAT) return "format";
  if (h.version !== BUNDLE_VERSION) return "version";
  if (!isSaturdayDate(h.edition)) return "edition";
  if (typeof h.runId !== "string" || !RUN_ID.test(h.runId)) return "runId";
  if (typeof h.workflow !== "string" || !WORKFLOW.test(h.workflow))
    return "workflow";
  if (!MODES.includes(h.mode)) return "mode";
  if (typeof h.keyId !== "string" || !/^[0-9a-f]{16}$/.test(h.keyId))
    return "keyId";
  if (
    typeof h.createdAt !== "string" ||
    Number.isNaN(Date.parse(h.createdAt)) ||
    new Date(h.createdAt).toISOString() !== h.createdAt
  )
    return "createdAt";
  if (
    !Number.isSafeInteger(h.payloadBytes) ||
    h.payloadBytes < 1 ||
    h.payloadBytes > MAX_PAYLOAD_BYTES
  )
    return "payloadBytes";
  return null;
}

/**
 * Checks that a research report and draft edition are one successful run's
 * output: same run, edition and mode; the report's selected candidates are
 * exactly the draft's stories, in order; the report's final validation passed;
 * the draft has the Phase 1 edition schema. Returns { edition, runId, mode }.
 */
export function checkResearchPair(report, draft) {
  const bad = (message) => fail("INCONSISTENT", message);
  const isObject = (v) =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObject(report) || !isObject(draft))
    bad("report and draft must be objects");
  if (report.schema !== REPORT_SCHEMA) bad("report schema");
  if (report.status !== "edition") bad("report status is not edition");
  if (typeof report.runId !== "string" || !RUN_ID.test(report.runId))
    bad("report runId");
  if (!isSaturdayDate(report.edition)) bad("report edition");
  if (!MODES.includes(report.mode)) bad("report mode");
  if (report.validation?.ok !== true) bad("report validation did not pass");
  const schemaErrors = checkSchema(draft);
  if (schemaErrors.length)
    bad(`draft schema: ${schemaErrors.map((e) => e.path).join(", ")}`);
  if (draft.edition !== report.edition) bad("edition differs");
  if (draft.publishedOn !== addDays(report.edition, 1))
    bad("draft publishedOn");
  const generation = draft.generation;
  if (!isObject(generation)) bad("draft generation");
  if (generation.runId !== report.runId) bad("run differs");
  if (generation.mode !== report.mode) bad("mode differs");
  if (generation.estimatedCostUsd !== report.budget?.runTotalCountedUsd)
    bad("cost differs");
  const selected = report.selected;
  if (!Array.isArray(selected) || selected.length !== draft.stories.length)
    bad("selected stories differ");
  if (!Array.isArray(report.candidates)) bad("report candidates");
  selected.forEach((key, i) => {
    const story = draft.stories[i];
    const matches = report.candidates.filter((c) => c?.key === key);
    if (
      matches.length !== 1 ||
      matches[0].status !== "selected" ||
      matches[0].storyId !== story.id ||
      story.id !== `s${i + 1}` ||
      matches[0].url !== story.url
    )
      bad(`story ${i + 1} does not match the report's selected candidate`);
  });
  return { edition: report.edition, runId: report.runId, mode: report.mode };
}

/** Encrypts one research result. Returns { bytes, digest, header }. */
export function sealBundle({ report, draft, workflow, key, now = new Date() }) {
  if (!Buffer.isBuffer(key) || key.length !== 32)
    fail("KEY_INVALID", "The artifact key must be 32 bytes");
  const identity = checkResearchPair(report, draft);
  const payload = Buffer.from(
    JSON.stringify({
      format: PAYLOAD_FORMAT,
      ...identity,
      workflow,
      report,
      draft,
    }),
    "utf8",
  );
  if (payload.length > MAX_PAYLOAD_BYTES)
    fail(
      "OVERSIZED",
      `Payload is ${payload.length} bytes (max ${MAX_PAYLOAD_BYTES})`,
    );
  const header = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    ...identity,
    workflow,
    keyId: keyId(key),
    createdAt: now.toISOString(),
    payloadBytes: payload.length,
  };
  const problem = headerProblem(header);
  if (problem) fail("INVALID_INPUT", `Invalid bundle ${problem}`);
  const headerBytes = Buffer.from(canonical(header), "utf8");
  if (headerBytes.length > MAX_HEADER_BYTES)
    fail("INVALID_INPUT", "Header too long");
  const prefix = Buffer.alloc(PREFIX_BYTES);
  MAGIC.copy(prefix);
  prefix.writeUInt8(BUNDLE_VERSION, MAGIC.length);
  prefix.writeUInt16BE(headerBytes.length, MAGIC.length + 1);
  const iv = randomBytes(IV_BYTES);
  const aad = Buffer.concat([prefix, headerBytes, iv]);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  payload.fill(0);
  const bytes = Buffer.concat([aad, ciphertext, cipher.getAuthTag()]);
  return { bytes, digest: bundleDigest(bytes), header };
}

/** Parses the unauthenticated framing; nothing here is trusted yet. */
function frame(bytes) {
  if (!Buffer.isBuffer(bytes)) fail("MALFORMED", "Bundle must be bytes");
  if (bytes.length > MAX_BUNDLE_BYTES) fail("OVERSIZED", "Bundle is too large");
  if (bytes.length < PREFIX_BYTES + IV_BYTES + TAG_BYTES)
    fail("MALFORMED", "Bundle is truncated");
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC))
    fail("MALFORMED", "Not a Tech Brief bundle");
  const version = bytes.readUInt8(MAGIC.length);
  if (version !== BUNDLE_VERSION)
    fail("UNSUPPORTED_VERSION", `Bundle version ${version} is not supported`);
  const headerLength = bytes.readUInt16BE(MAGIC.length + 1);
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES)
    fail("MALFORMED", "Header length out of range");
  const headerEnd = PREFIX_BYTES + headerLength;
  if (bytes.length < headerEnd + IV_BYTES + TAG_BYTES)
    fail("MALFORMED", "Bundle is truncated");
  const headerText = bytes.subarray(PREFIX_BYTES, headerEnd).toString("utf8");
  let header;
  try {
    header = JSON.parse(headerText);
  } catch {
    fail("MALFORMED", "Header is not JSON");
  }
  if (
    header === null ||
    typeof header !== "object" ||
    Array.isArray(header) ||
    Object.keys(header).length !== HEADER_FIELDS.length ||
    canonical(header) !== headerText
  )
    fail("MALFORMED", "Header is not in canonical form");
  if (header.version !== version)
    fail("MALFORMED", "Header and framing versions differ");
  const problem = headerProblem(header);
  if (problem) fail("MALFORMED", `Invalid header ${problem}`);
  if (bytes.length !== headerEnd + IV_BYTES + header.payloadBytes + TAG_BYTES)
    fail(
      "MALFORMED",
      "Bundle length does not match its header (truncated or extended)",
    );
  const ivEnd = headerEnd + IV_BYTES;
  return {
    header,
    aad: bytes.subarray(0, ivEnd),
    iv: bytes.subarray(headerEnd, ivEnd),
    ciphertext: bytes.subarray(ivEnd, bytes.length - TAG_BYTES),
    tag: bytes.subarray(bytes.length - TAG_BYTES),
  };
}

/**
 * Verifies and decrypts a bundle. `digest` is the recorded SHA-256; `expected`
 * is { edition, runId, workflow, mode }; `keys` holds the current key and,
 * during a rotation, the previous one. Returns { header, report, draft } or
 * throws BundleError. Nothing is written to disk.
 */
export function openBundle(bytes, { digest, expected, keys }) {
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
    fail("DIGEST_REQUIRED", "The recorded bundle digest is required");
  for (const field of ["edition", "runId", "workflow", "mode"])
    if (typeof expected?.[field] !== "string" || !expected[field])
      fail("EXPECTED_REQUIRED", `Expected ${field} is required`);
  if (!Array.isArray(keys) || keys.length === 0)
    fail("KEY_MISSING", "No artifact key was supplied");
  for (const key of keys)
    if (!Buffer.isBuffer(key) || key.length !== 32)
      fail("KEY_INVALID", "The artifact key must be 32 bytes");
  if (!Buffer.isBuffer(bytes)) fail("MALFORMED", "Bundle must be bytes");
  if (bytes.length > MAX_BUNDLE_BYTES) fail("OVERSIZED", "Bundle is too large");
  const actual = Buffer.from(bundleDigest(bytes), "hex");
  if (!timingSafeEqual(actual, Buffer.from(digest, "hex")))
    fail("DIGEST_MISMATCH", "The bundle does not match its recorded digest");

  const { header, aad, iv, ciphertext, tag } = frame(bytes);
  const key = keys.find((k) => keyId(k) === header.keyId);
  if (!key)
    fail("KEY_MISMATCH", "None of the supplied keys sealed this bundle");
  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const body = decipher.update(ciphertext);
    try {
      plaintext = Buffer.concat([body, decipher.final()]);
    } finally {
      body.fill(0);
    }
  } catch {
    fail("AUTHENTICATION_FAILED", "The bundle failed authentication");
  }

  try {
    // From here the header is authenticated; check it is the expected bundle.
    const mismatches = [
      ["edition", "EDITION_MISMATCH"],
      ["runId", "RUN_MISMATCH"],
      ["workflow", "WORKFLOW_MISMATCH"],
      ["mode", "MODE_MISMATCH"],
    ];
    for (const [field, code] of mismatches)
      if (header[field] !== expected[field])
        fail(code, `Bundle ${field} is not the expected one`);
    let payload;
    try {
      payload = JSON.parse(plaintext.toString("utf8"));
    } catch {
      fail("INCONSISTENT", "Payload is not JSON");
    }
    if (payload?.format !== PAYLOAD_FORMAT)
      fail("INCONSISTENT", "Payload format");
    for (const field of ["edition", "runId", "workflow", "mode"])
      if (payload[field] !== header[field])
        fail("INCONSISTENT", `Payload ${field} differs from the header`);
    const identity = checkResearchPair(payload.report, payload.draft);
    for (const field of ["edition", "runId", "mode"])
      if (identity[field] !== header[field])
        fail("INCONSISTENT", `Report ${field} differs from the header`);
    return { header, report: payload.report, draft: payload.draft };
  } finally {
    plaintext.fill(0);
  }
}

function keysFromEnv(env) {
  const keys = [parseKey(env.TECH_BRIEF_ARTIFACT_KEY ?? "")];
  if (env.TECH_BRIEF_ARTIFACT_KEY_PREVIOUS)
    keys.push(parseKey(env.TECH_BRIEF_ARTIFACT_KEY_PREVIOUS));
  return keys;
}

/** Writes a new file atomically; refuses to overwrite and leaves no temporary file behind. */
function writeNewFile(path, bytes) {
  if (existsSync(path))
    fail("OUTPUT_EXISTS", `${basename(path)} already exists`);
  const tmp = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  const fd = openSync(tmp, "wx");
  try {
    try {
      writeSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    if (existsSync(path))
      fail("OUTPUT_EXISTS", `${basename(path)} already exists`);
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw error;
  }
}

// CLI ------------------------------------------------------------------------------------------
// Keys come from TECH_BRIEF_ARTIFACT_KEY (and _PREVIOUS); they are never printed.
// node scripts/tech-brief/bundle.mjs seal --report R --draft D --workflow W --out FILE
// node scripts/tech-brief/bundle.mjs verify --in FILE --digest HEX --edition E
//   --run-id R --workflow W --mode M
// Output is one JSON object with identifiers, counts and the digest only (no
// story text). Exit 0 ok, 4 refused, 1 usage error.
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
  const readJson = (path) => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      fail("INVALID_INPUT", `Cannot read JSON from ${basename(path ?? "")}`);
    }
  };
  try {
    if (command === "seal") {
      for (const name of ["--report", "--draft", "--workflow", "--out"])
        if (!option(name))
          out(1, { ok: false, code: "USAGE", message: `${name} is required` });
      const [key] = keysFromEnv(process.env);
      const sealed = sealBundle({
        report: readJson(option("--report")),
        draft: readJson(option("--draft")),
        workflow: option("--workflow"),
        key,
      });
      writeNewFile(option("--out"), sealed.bytes);
      out(0, {
        ok: true,
        command,
        digest: sealed.digest,
        bytes: sealed.bytes.length,
        edition: sealed.header.edition,
        runId: sealed.header.runId,
        mode: sealed.header.mode,
        keyId: sealed.header.keyId,
      });
    } else if (command === "verify") {
      for (const name of [
        "--in",
        "--digest",
        "--edition",
        "--run-id",
        "--workflow",
        "--mode",
      ])
        if (!option(name))
          out(1, { ok: false, code: "USAGE", message: `${name} is required` });
      let bytes;
      try {
        if (statSync(option("--in")).size > MAX_BUNDLE_BYTES)
          fail("OVERSIZED", "Bundle is too large");
        bytes = readFileSync(option("--in"));
      } catch (error) {
        if (error instanceof BundleError) throw error;
        fail("MALFORMED", "Cannot read the bundle file");
      }
      const opened = openBundle(bytes, {
        digest: option("--digest"),
        expected: {
          edition: option("--edition"),
          runId: option("--run-id"),
          workflow: option("--workflow"),
          mode: option("--mode"),
        },
        keys: keysFromEnv(process.env),
      });
      out(0, {
        ok: true,
        command,
        edition: opened.header.edition,
        runId: opened.header.runId,
        mode: opened.header.mode,
        workflow: opened.header.workflow,
        stories: opened.draft.stories.length,
      });
    } else {
      out(1, { ok: false, code: "USAGE", message: "Commands: seal, verify" });
    }
  } catch (error) {
    if (error instanceof BundleError)
      out(4, { ok: false, code: error.code, message: error.message });
    out(4, { ok: false, code: "ERROR", message: "Unexpected failure" });
  }
}
