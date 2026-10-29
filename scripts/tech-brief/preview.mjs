// Editorial preview: lets the editor read the exact public edition before a
// supervised publication, without publishing it and without any paid call.
//
// The preview workflow (.github/workflows/tech-brief-preview.yml, read-only
// token, tech-brief-publish environment) runs the Sunday publication checks
// with write: false (automation.mjs previewSunday): ledger handoff, GitHub
// provenance, bundle decryption, every publish.mjs check including the real
// publication window and the Sunday source recheck. It then encrypts only the
// public result to the reviewer's public key and uploads that file:
//   - the exact public file text that publication would write, and its
//     SHA-256 (contentDigest), which is what the reviewer approves;
//   - warning codes, and dropped stories (reasons plus their public fields);
//   - identifiers of the research run, artifact and preview run;
//   - for a corrected edition (corrections.mjs), the corrections digest, the
//     uncorrected content digest and each correction's before/after public
//     text, reasons, note and cited public quotes (null when uncorrected).
// Research evidence (claims, quotes, editorial facets, costs) is never in it.
//
// Encryption: X25519 with a fresh ephemeral key per preview, HKDF-SHA256 over
// the shared secret (salt: both public keys), AES-256-GCM with the framing and
// header as additional data. Only the reviewer's private key, which never
// leaves the reviewer's computer, can open it. The public key is the
// environment variable TECH_BRIEF_REVIEWER_PUBLIC_KEY (base64 SPKI DER), so
// no new secret is needed; the key id (SHA-256 of the public key) appears in
// logs so the reviewer can check which key was used.
//
// File format (all integers big-endian):
//   "OFTBPREV" | version (1 byte) | header length (2 bytes) | header (canonical
//   JSON) | IV (12 bytes) | ciphertext | GCM tag (16 bytes)
//
// Local use (outside the repository only; see the CLI below):
//   keygen      creates the reviewer key pair (private key file + public key)
//   public-key  prints the public key and key id of a private key file
//   open        decrypts a downloaded preview into a folder of readable files

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  contentDigest,
  publicEdition,
  publicEditionProblems,
  serializeEdition,
} from "./publish.mjs";
import { isSaturdayDate } from "./schedule.mjs";
import { renderCorrections } from "./corrections.mjs";

export const PREVIEW_FORMAT = "ourfaces-tech-brief-preview";
export const PREVIEW_VERSION = 1;
export const PREVIEW_FILE = "editorial-preview.bin";
export const REVIEWER_KEY_VARIABLE = "TECH_BRIEF_REVIEWER_PUBLIC_KEY";
const PAYLOAD_FORMAT = "ourfaces-tech-brief-preview-payload/2";
const MAGIC = Buffer.from("OFTBPREV", "ascii");
const MAX_HEADER_BYTES = 512;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX_BYTES = MAGIC.length + 1 + 2;
const MAX_PREVIEW_BYTES =
  PREFIX_BYTES + MAX_HEADER_BYTES + IV_BYTES + MAX_PAYLOAD_BYTES + TAG_BYTES;
const HEADER_FIELDS = [
  "format",
  "version",
  "edition",
  "recipientKeyId",
  "ephemeralKey",
  "createdAt",
  "payloadBytes",
];
const KDF_INFO = Buffer.from("ourfaces-tech-brief-preview/1 aes-256-gcm");
// base64 of an X25519 SubjectPublicKeyInfo: fixed 12-byte prefix + 32 bytes.
const PUBLIC_KEY_BASE64 = /^MCowBQYDK2VuAyEA[A-Za-z0-9+/]{43}=$/;
const CODE = /^[A-Z][A-Z0-9_]*(:[A-Za-z0-9_.-]+)?$/;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export class PreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreviewError";
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new PreviewError(code, message);
};
const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const spki = (key) => key.export({ type: "spki", format: "der" });

/** Key id: the first 16 hex digits of the SHA-256 of the public key (SPKI DER). */
export const reviewerKeyId = (publicKey) =>
  createHash("sha256").update(spki(publicKey)).digest("hex").slice(0, 16);

/** The reviewer's X25519 public key from its base64 SPKI form; anything else is refused. */
export function parseReviewerPublicKey(text) {
  if (typeof text !== "string" || text.length === 0)
    fail(
      "REVIEWER_KEY_MISSING",
      `No reviewer public key (${REVIEWER_KEY_VARIABLE}) was supplied`,
    );
  if (!PUBLIC_KEY_BASE64.test(text))
    fail(
      "REVIEWER_KEY_INVALID",
      "The reviewer public key must be an X25519 public key (base64 SPKI)",
    );
  let key;
  try {
    key = createPublicKey({
      key: Buffer.from(text, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    fail("REVIEWER_KEY_INVALID", "The reviewer public key cannot be parsed");
  }
  if (
    key.asymmetricKeyType !== "x25519" ||
    spki(key).toString("base64") !== text
  )
    fail(
      "REVIEWER_KEY_INVALID",
      "The reviewer public key must be an X25519 public key (base64 SPKI)",
    );
  return key;
}

/** The reviewer's X25519 private key from a PKCS#8 PEM file's text. */
export function parseReviewerPrivateKey(pem) {
  let key;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    fail("REVIEWER_KEY_INVALID", "The reviewer private key cannot be read");
  }
  if (key.asymmetricKeyType !== "x25519")
    fail("REVIEWER_KEY_INVALID", "The reviewer private key must be X25519");
  return key;
}

/** A new reviewer key pair: { privateKeyPem, publicKey (base64 SPKI), keyId }. */
export function generateReviewerKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKey: spki(publicKey).toString("base64"),
    keyId: reviewerKeyId(publicKey),
  };
}

function aesKey(privateKey, peerPublicKey, ephemeralPublic, recipientPublic) {
  let shared;
  try {
    shared = diffieHellman({ privateKey, publicKey: peerPublicKey });
  } catch {
    fail("REVIEWER_KEY_INVALID", "Key agreement failed");
  }
  if (shared.every((b) => b === 0))
    fail("REVIEWER_KEY_INVALID", "Key agreement failed");
  const salt = Buffer.concat([spki(ephemeralPublic), spki(recipientPublic)]);
  const key = Buffer.from(hkdfSync("sha256", shared, salt, KDF_INFO, 32));
  shared.fill(0);
  return key;
}

const canonical = (header) =>
  JSON.stringify(Object.fromEntries(HEADER_FIELDS.map((k) => [k, header[k]])));

function headerProblem(h) {
  if (h.format !== PREVIEW_FORMAT) return "format";
  if (h.version !== PREVIEW_VERSION) return "version";
  if (!isSaturdayDate(h.edition)) return "edition";
  if (
    typeof h.recipientKeyId !== "string" ||
    !/^[0-9a-f]{16}$/.test(h.recipientKeyId)
  )
    return "recipientKeyId";
  if (
    typeof h.ephemeralKey !== "string" ||
    !PUBLIC_KEY_BASE64.test(h.ephemeralKey)
  )
    return "ephemeralKey";
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

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const codes = (list) =>
  Array.isArray(list) &&
  list.every((c) => typeof c === "string" && CODE.test(c));

/** Problems with a preview payload; [] when it is consistent and public-only. */
export function previewProblems(payload) {
  if (!isObject(payload)) return ["payload"];
  const problems = [];
  const keys = [
    "format",
    "edition",
    "createdAt",
    "contentDigest",
    "publication",
    "warnings",
    "dropped",
    "droppedStories",
    "source",
    "preview",
    "corrections",
  ];
  if (
    Object.keys(payload).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(payload, k))
  )
    problems.push("fields");
  if (payload.format !== PAYLOAD_FORMAT) problems.push("format");
  if (!isSaturdayDate(payload.edition)) problems.push("edition");
  if (typeof payload.publication !== "string")
    return [...problems, "publication"];
  if (payload.contentDigest !== contentDigest(payload.publication))
    problems.push("contentDigest");
  let edition = null;
  try {
    edition = JSON.parse(payload.publication);
  } catch {
    problems.push("publication");
  }
  if (edition !== null) {
    if (publicEditionProblems(edition).length) problems.push("publication");
    else if (serializeEdition(edition) !== payload.publication)
      problems.push("publication");
    if (edition?.edition !== payload.edition) problems.push("edition");
  }
  if (!codes(payload.warnings)) problems.push("warnings");
  if (
    !Array.isArray(payload.dropped) ||
    !payload.dropped.every(
      (d) =>
        isObject(d) &&
        Object.keys(d).length === 2 &&
        typeof d.id === "string" &&
        codes(d.reasons),
    )
  )
    problems.push("dropped");
  // Public fields only: projecting the stories again must change nothing.
  if (
    !Array.isArray(payload.droppedStories) ||
    !payload.droppedStories.every(
      (st) => isObject(st) && isObject(st.en) && isObject(st.fr),
    ) ||
    JSON.stringify(
      publicEdition({ stories: payload.droppedStories }).stories,
    ) !== JSON.stringify(payload.droppedStories) ||
    payload.droppedStories.length !== payload.dropped?.length
  )
    problems.push("droppedStories");
  const s = payload.source;
  if (
    !isObject(s) ||
    typeof s.reservationId !== "string" ||
    typeof s.researchRunId !== "string" ||
    !isId(s.workflowRunId) ||
    !isId(s.runAttempt) ||
    !isId(s.artifactId) ||
    typeof s.bundleDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(s.bundleDigest)
  )
    problems.push("source");
  const p = payload.preview;
  if (
    !isObject(p) ||
    !(p.workflowRunId === null || isId(p.workflowRunId)) ||
    !(p.runAttempt === null || isId(p.runAttempt))
  )
    problems.push("preview");
  if (payload.corrections !== null && correctionsProblem(payload, edition))
    problems.push("corrections");
  return problems;
}

const strings = (o) =>
  isObject(o) && Object.values(o).every((v) => typeof v === "string");
/** True when a corrections summary is malformed or disagrees with the publication. */
function correctionsProblem(payload, edition) {
  const c = payload.corrections;
  const digest = /^[0-9a-f]{64}$/;
  if (
    !isObject(c) ||
    Object.keys(c).length !== 5 ||
    !digest.test(c.correctionsDigest ?? "") ||
    !digest.test(c.originalDigest ?? "") ||
    !Array.isArray(c.revised) ||
    !Array.isArray(c.excluded) ||
    !Array.isArray(c.stories)
  )
    return true;
  const ids = new Set(edition?.stories?.map((s) => s.id) ?? []);
  return !c.stories.every(
    (e) =>
      isObject(e) &&
      typeof e.storyId === "string" &&
      ["revise", "exclude"].includes(e.action) &&
      codes(e.reasons) &&
      typeof e.note === "string" &&
      Array.isArray(e.evidence) &&
      e.evidence.every(
        (q) => typeof q?.url === "string" && typeof q?.quote === "string",
      ) &&
      (e.action === "exclude"
        ? e.before === null &&
          e.after === null &&
          c.excluded.includes(e.storyId) &&
          !ids.has(e.storyId)
        : c.revised.includes(e.storyId) &&
          ["en", "fr"].every(
            (l) => strings(e.before?.[l]) && strings(e.after?.[l]),
          )),
  );
}

/**
 * The preview payload for a "checked" publication outcome (publish.mjs with
 * write: false) and the handoff it came from. Public content only.
 */
export function buildPreview({
  outcome,
  handoff,
  previewRun = {},
  now = new Date(),
}) {
  if (outcome?.status !== "checked")
    fail("NOT_CHECKED", "Only a checked publication can be previewed");
  const payload = {
    format: PAYLOAD_FORMAT,
    edition: outcome.edition,
    createdAt: now.toISOString(),
    contentDigest: outcome.contentDigest,
    publication: outcome.text,
    warnings: outcome.warnings,
    dropped: outcome.dropped.map((d) => ({ id: d.id, reasons: d.reasons })),
    droppedStories: outcome.droppedStories,
    source: {
      reservationId: handoff.reservationId,
      researchRunId: handoff.researchRunId,
      workflowRunId: handoff.workflowRunId,
      runAttempt: handoff.runAttempt,
      artifactId: handoff.artifactId,
      bundleDigest: handoff.bundleDigest,
    },
    preview: {
      workflowRunId: previewRun.workflowRunId ?? null,
      runAttempt: previewRun.runAttempt ?? null,
    },
    corrections: outcome.corrections
      ? { ...outcome.corrections, stories: outcome.correctionReview }
      : null,
  };
  const problems = previewProblems(payload);
  if (problems.length)
    fail("INVALID_PREVIEW", `Invalid preview: ${problems.join(", ")}`);
  return payload;
}

/** Encrypts a preview payload to the reviewer's public key. Returns { bytes, digest, header }. */
export function sealPreview({ payload, recipient, now = new Date() }) {
  if (recipient?.asymmetricKeyType !== "x25519" || recipient.type !== "public")
    fail("REVIEWER_KEY_INVALID", "The reviewer public key must be X25519");
  const problems = previewProblems(payload);
  if (problems.length)
    fail("INVALID_PREVIEW", `Invalid preview: ${problems.join(", ")}`);
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.length > MAX_PAYLOAD_BYTES)
    fail(
      "OVERSIZED",
      `Preview is ${body.length} bytes (max ${MAX_PAYLOAD_BYTES})`,
    );
  const ephemeral = generateKeyPairSync("x25519");
  const header = {
    format: PREVIEW_FORMAT,
    version: PREVIEW_VERSION,
    edition: payload.edition,
    recipientKeyId: reviewerKeyId(recipient),
    ephemeralKey: spki(ephemeral.publicKey).toString("base64"),
    createdAt: now.toISOString(),
    payloadBytes: body.length,
  };
  const problem = headerProblem(header);
  if (problem) fail("INVALID_PREVIEW", `Invalid preview ${problem}`);
  const headerBytes = Buffer.from(canonical(header), "utf8");
  const prefix = Buffer.alloc(PREFIX_BYTES);
  MAGIC.copy(prefix);
  prefix.writeUInt8(PREVIEW_VERSION, MAGIC.length);
  prefix.writeUInt16BE(headerBytes.length, MAGIC.length + 1);
  const iv = randomBytes(IV_BYTES);
  const aad = Buffer.concat([prefix, headerBytes, iv]);
  const key = aesKey(
    ephemeral.privateKey,
    recipient,
    ephemeral.publicKey,
    recipient,
  );
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    const bytes = Buffer.concat([aad, ciphertext, cipher.getAuthTag()]);
    return {
      bytes,
      digest: createHash("sha256").update(bytes).digest("hex"),
      header,
    };
  } finally {
    key.fill(0);
    body.fill(0);
  }
}

/** Parses the unauthenticated framing; nothing here is trusted yet. */
function frame(bytes) {
  if (!Buffer.isBuffer(bytes)) fail("MALFORMED", "Preview must be bytes");
  if (bytes.length > MAX_PREVIEW_BYTES)
    fail("OVERSIZED", "Preview is too large");
  if (bytes.length < PREFIX_BYTES + IV_BYTES + TAG_BYTES)
    fail("MALFORMED", "Preview is truncated");
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC))
    fail("MALFORMED", "Not a Tech Brief editorial preview");
  const version = bytes.readUInt8(MAGIC.length);
  if (version !== PREVIEW_VERSION)
    fail("UNSUPPORTED_VERSION", `Preview version ${version} is not supported`);
  const headerLength = bytes.readUInt16BE(MAGIC.length + 1);
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES)
    fail("MALFORMED", "Header length out of range");
  const headerEnd = PREFIX_BYTES + headerLength;
  if (bytes.length < headerEnd + IV_BYTES + TAG_BYTES)
    fail("MALFORMED", "Preview is truncated");
  const headerText = bytes.subarray(PREFIX_BYTES, headerEnd).toString("utf8");
  let header;
  try {
    header = JSON.parse(headerText);
  } catch {
    fail("MALFORMED", "Header is not JSON");
  }
  if (
    !isObject(header) ||
    Object.keys(header).length !== HEADER_FIELDS.length ||
    canonical(header) !== headerText
  )
    fail("MALFORMED", "Header is not in canonical form");
  const problem = headerProblem(header);
  if (problem) fail("MALFORMED", `Invalid header ${problem}`);
  if (bytes.length !== headerEnd + IV_BYTES + header.payloadBytes + TAG_BYTES)
    fail("MALFORMED", "Preview length does not match its header");
  const ivEnd = headerEnd + IV_BYTES;
  return {
    header,
    aad: bytes.subarray(0, ivEnd),
    iv: bytes.subarray(headerEnd, ivEnd),
    ciphertext: bytes.subarray(ivEnd, bytes.length - TAG_BYTES),
    tag: bytes.subarray(bytes.length - TAG_BYTES),
  };
}

/** Authenticates and decrypts a preview with the reviewer's private key. Returns the payload. */
export function openPreview(bytes, privateKey) {
  if (
    privateKey?.asymmetricKeyType !== "x25519" ||
    privateKey.type !== "private"
  )
    fail("REVIEWER_KEY_INVALID", "The reviewer private key must be X25519");
  const { header, aad, iv, ciphertext, tag } = frame(bytes);
  const recipient = createPublicKey(privateKey);
  if (reviewerKeyId(recipient) !== header.recipientKeyId)
    fail(
      "REVIEWER_KEY_MISMATCH",
      "This preview was encrypted for a different reviewer key",
    );
  const ephemeral = parseReviewerPublicKey(header.ephemeralKey);
  const key = aesKey(privateKey, ephemeral, ephemeral, recipient);
  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    fail("AUTHENTICATION_FAILED", "The preview failed authentication");
  } finally {
    key.fill(0);
  }
  let payload;
  try {
    payload = JSON.parse(plaintext.toString("utf8"));
  } catch {
    fail("INCONSISTENT", "Preview payload is not JSON");
  }
  const problems = previewProblems(payload);
  if (problems.length)
    fail("INCONSISTENT", `Preview payload: ${problems.join(", ")}`);
  if (payload.edition !== header.edition)
    fail("INCONSISTENT", "Preview edition differs from its header");
  return payload;
}

/** A plain-text rendering of a preview payload for reading. */
export function renderPreview(payload) {
  const edition = JSON.parse(payload.publication);
  const categories = [...new Set(edition.stories.map((s) => s.category))];
  const lines = [
    "OURFACES TECH BRIEF - EDITORIAL PREVIEW (NOT PUBLISHED)",
    "",
    `Edition: ${edition.edition} (publishedOn ${edition.publishedOn})`,
    `Content digest to approve: ${payload.contentDigest}`,
    `Stories: ${edition.stories.length}; categories: ${categories.join(", ")}`,
    `Warnings: ${payload.warnings.length ? payload.warnings.join(", ") : "none"}`,
    `Dropped by the Sunday source recheck: ${payload.dropped.length}`,
    `Research run ${payload.source.researchRunId}, workflow run ${payload.source.workflowRunId} attempt ${payload.source.runAttempt}, artifact ${payload.source.artifactId}`,
    `Preview prepared ${payload.createdAt}`,
    `Editorial corrections: ${payload.corrections ? `${payload.corrections.revised.length} revised, ${payload.corrections.excluded.length} excluded (see the end)` : "none"}`,
  ];
  const story = (s, title) => {
    lines.push(
      "",
      `=== ${title}: ${s.id} [${s.category}] ===`,
      `Publisher: ${s.publisher}; source published on ${s.sourcePublishedOn}`,
      `Source headline (${s.sourceHeadlineLang}): ${s.sourceHeadline}`,
      `Link: ${s.url}`,
    );
    for (const lang of ["en", "fr"])
      lines.push(
        "",
        `[${lang.toUpperCase()}] headline: ${s[lang].headline}`,
        `[${lang.toUpperCase()}] summary: ${s[lang].summary}`,
        `[${lang.toUpperCase()}] why it matters: ${s[lang].whyItMatters}`,
      );
  };
  edition.stories.forEach((s, i) =>
    story(s, `Story ${i + 1} of ${edition.stories.length}`),
  );
  for (const s of payload.droppedStories) {
    const reasons = payload.dropped.find((d) => d.id === s.id)?.reasons ?? [];
    story(s, `DROPPED, not in the publication (${reasons.join(", ")})`);
  }
  if (payload.corrections)
    lines.push(
      "",
      "=== EDITORIAL CORRECTIONS (before / after) ===",
      renderCorrections(payload.corrections, payload.corrections.stories),
    );
  lines.push(
    "",
    "To publish exactly this edition, dispatch the publication workflow with",
    `approved_digest = ${payload.contentDigest}`,
    "Any difference at publication time refuses it and needs a new preview.",
    "",
  );
  return lines.join("\n");
}

/** Whether a path (existing or not) is inside this repository, after resolving links and short names. */
export function insideRepository(path, root = REPOSITORY_ROOT) {
  const real = (p) => {
    let current = resolve(p);
    const rest = [];
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) break;
      rest.unshift(basename(current));
      current = parent;
    }
    const full = join(realpathSync.native(current), ...rest);
    return process.platform === "win32" ? full.toLowerCase() : full;
  };
  const rel = relative(real(root), real(path));
  return rel === "" || (!isAbsolute(rel) && rel.split(sep)[0] !== "..");
}

function outsideRepository(path, what) {
  if (!path) fail("USAGE", `${what} is required`);
  if (insideRepository(path))
    fail(
      "INSIDE_REPOSITORY",
      `${what} must be outside the repository, so nothing private can be committed`,
    );
}

/** The single file of a preview: the path itself, or the one file in a downloaded folder. */
function previewFile(path) {
  if (!statSync(path).isDirectory()) return path;
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(path);
  if (files.length !== 1)
    fail(
      "MALFORMED",
      `Expected one file in the preview folder, found ${files.length}`,
    );
  return files[0];
}

// CLI ------------------------------------------------------------------------------------------
// node scripts/tech-brief/preview.mjs keygen --out PRIVATE_KEY_FILE
// node scripts/tech-brief/preview.mjs public-key --key PRIVATE_KEY_FILE
// node scripts/tech-brief/preview.mjs open --in FILE_OR_FOLDER --key PRIVATE_KEY_FILE --out FOLDER
// Key files and output folders must be outside the repository; nothing is
// overwritten. Output is one JSON object with identifiers, counts, the public
// key and the content digest only (never story text or private key material).
// Exit 0 ok, 4 refused, 1 usage error.
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
  const readKey = (path) => {
    if (!path) fail("USAGE", "--key is required");
    let pem;
    try {
      pem = readFileSync(path, "utf8");
    } catch {
      fail("REVIEWER_KEY_MISSING", "Cannot read the reviewer private key file");
    }
    return parseReviewerPrivateKey(pem);
  };
  try {
    if (command === "keygen") {
      const path = option("--out");
      outsideRepository(path, "--out");
      if (existsSync(path))
        fail("OUTPUT_EXISTS", `${basename(path)} already exists`);
      const pair = generateReviewerKeyPair();
      mkdirSync(dirname(resolve(path)), { recursive: true });
      writeFileSync(path, pair.privateKeyPem, { flag: "wx", mode: 0o600 });
      out(0, {
        ok: true,
        command,
        privateKeyFile: resolve(path),
        publicKey: pair.publicKey,
        keyId: pair.keyId,
      });
    } else if (command === "public-key") {
      const publicKey = createPublicKey(readKey(option("--key")));
      out(0, {
        ok: true,
        command,
        publicKey: spki(publicKey).toString("base64"),
        keyId: reviewerKeyId(publicKey),
      });
    } else if (command === "open") {
      const dir = option("--out");
      outsideRepository(dir, "--out");
      const key = readKey(option("--key"));
      if (!option("--in")) fail("USAGE", "--in is required");
      let bytes;
      try {
        const file = previewFile(option("--in"));
        if (statSync(file).size > MAX_PREVIEW_BYTES)
          fail("OVERSIZED", "Preview is too large");
        bytes = readFileSync(file);
      } catch (error) {
        if (error instanceof PreviewError) throw error;
        fail("MALFORMED", "Cannot read the preview file");
      }
      const payload = openPreview(bytes, key);
      const names = {
        text: `editorial-preview-${payload.edition}.txt`,
        json: `editorial-preview-${payload.edition}.json`,
        latest: "latest.json",
      };
      mkdirSync(dir, { recursive: true });
      for (const name of Object.values(names))
        if (existsSync(join(dir, name)))
          fail("OUTPUT_EXISTS", `${name} already exists in --out`);
      writeFileSync(join(dir, names.text), renderPreview(payload), {
        flag: "wx",
      });
      writeFileSync(
        join(dir, names.json),
        `${JSON.stringify(payload, null, 2)}\n`,
        {
          flag: "wx",
        },
      );
      writeFileSync(join(dir, names.latest), payload.publication, {
        flag: "wx",
      });
      const edition = JSON.parse(payload.publication);
      out(0, {
        ok: true,
        command,
        edition: payload.edition,
        stories: edition.stories.length,
        categories: new Set(edition.stories.map((s) => s.category)).size,
        dropped: payload.dropped.length,
        warnings: payload.warnings.length,
        contentDigest: payload.contentDigest,
        outDir: resolve(dir),
        files: Object.values(names),
      });
    } else
      out(1, {
        ok: false,
        code: "USAGE",
        message: `Unknown command ${command}`,
      });
  } catch (error) {
    out(error?.code === "USAGE" ? 1 : 4, {
      ok: false,
      code: error?.code ?? "ERROR",
      message:
        error instanceof PreviewError ? error.message : "Unexpected failure",
    });
  }
}
