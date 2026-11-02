// Contact API (src/app/api/contact/route.ts): request-body limit, rate
// limiting and the existing validation and email behaviour. Local only: the
// route is loaded through Node's TypeScript type stripping from a temporary
// copy whose "next/server" and "nodemailer" imports are replaced, nodemailer
// by tests/contact/fake-nodemailer.mjs, so no email is ever sent.
// Each test loads a fresh copy of the module, i.e. a fresh function instance.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { calls, resetMailer } from "./fake-nodemailer.mjs";

const ROOT = new URL("../../", import.meta.url);
const ROUTE = new URL("src/app/api/contact/route.ts", ROOT);
const FORM = new URL("src/components/ContactForm.tsx", ROOT);
const NEXT_SERVER = new URL("node_modules/next/server.js", ROOT).href;
const FAKE_MAILER = new URL("fake-nodemailer.mjs", import.meta.url).href;

const SMTP_USER = "contact-test-user@example.invalid";
const SMTP_PASSWORD = "test-password-not-real-7f3c";
const LIMIT = 20_000;

const dir = mkdtempSync(join(tmpdir(), "ourfaces-contact-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const source = readFileSync(ROUTE, "utf8");
const patched = source
  .replace('from "next/server";', `from ${JSON.stringify(NEXT_SERVER)};`)
  .replace('from "nodemailer";', `from ${JSON.stringify(FAKE_MAILER)};`);
assert.notEqual(patched, source);
assert.ok(!/from "(next\/server|nodemailer)";/.test(patched));
writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
writeFileSync(join(dir, "route.ts"), patched);
const routeUrl = pathToFileURL(join(dir, "route.ts")).href;

let instance = 0;
/** A fresh copy of the route module: a new, empty function instance. */
async function freshRoute() {
  instance += 1;
  return (await import(`${routeUrl}?instance=${instance}`)).POST;
}

const ENV_KEYS = [
  "VERCEL",
  "NODE_ENV",
  "ZOHO_SMTP_HOST",
  "ZOHO_SMTP_PORT",
  "ZOHO_SMTP_USER",
  "ZOHO_SMTP_APP_PASSWORD",
  "CONTACT_TO_EMAIL",
];
let savedEnv;
let logs;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.VERCEL = "1";
  process.env.ZOHO_SMTP_USER = SMTP_USER;
  process.env.ZOHO_SMTP_APP_PASSWORD = SMTP_PASSWORD;
  resetMailer();
  logs = [];
  for (const level of ["error", "warn", "log"])
    mock.method(console, level, (...args) =>
      logs.push(
        args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" "),
      ),
    );
});
afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
  for (const [k, v] of Object.entries(savedEnv))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  // No test may leak the SMTP password into a log line.
  for (const line of logs) assert.ok(!line.includes(SMTP_PASSWORD), line);
});

const VALID = {
  name: "Ada Lovelace",
  email: "Ada@Example.com",
  organization: "Analytical Engines",
  topic: "Technology",
  message: "Hello OurFaces.\nCould we talk?",
  website: "",
};
const encoder = new TextEncoder();

/** A request from the given client; `body` may be a string, bytes, a stream or null (no body); `ip: null` sends no x-real-ip. */
function request({
  body = JSON.stringify(VALID),
  ip = "198.51.100.10",
  headers = {},
} = {}) {
  const init = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(ip ? { "x-real-ip": ip } : {}),
      ...headers,
    },
  };
  if (body !== null) init.body = body;
  if (body instanceof ReadableStream) init.duplex = "half";
  return new Request("http://localhost/api/contact", init);
}

async function call(POST, options) {
  const response = await POST(request(options));
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json/,
  );
  const json = await response.json();
  // Every response has one of the two shapes the form expects.
  if (response.status === 200) assert.deepEqual(json, { ok: true });
  else {
    assert.deepEqual(Object.keys(json), ["error"]);
    assert.equal(typeof json.error, "string");
    assert.ok(
      !json.error.includes(SMTP_PASSWORD) && !json.error.includes(SMTP_USER),
    );
  }
  return { status: response.status, json };
}

/** A JSON body padded with trailing whitespace to exactly `bytes` bytes. */
function bodyOfSize(bytes, payload = VALID) {
  const json = JSON.stringify(payload);
  assert.ok(json.length <= bytes);
  return json + " ".repeat(bytes - Buffer.byteLength(json));
}

/** A pull-based stream of `total` bytes in `chunk`-byte pieces, recording how much was read. */
function countingStream(total, chunk = 1024, fill = " ") {
  const stats = { pulled: 0, cancelled: false };
  const piece = encoder.encode(fill.repeat(chunk));
  const stream = new ReadableStream({
    pull(controller) {
      if (stats.pulled >= total) return controller.close();
      const size = Math.min(chunk, total - stats.pulled);
      stats.pulled += size;
      controller.enqueue(piece.subarray(0, size));
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  return { stream, stats };
}

function streamOf(text, chunk = 7) {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + chunk));
      offset += chunk;
    },
  });
}

// --- Request-body protection -----------------------------------------------------------

test("a valid request within the limit is sent once, as plain text with the visitor as reply-to", async () => {
  const POST = await freshRoute();
  assert.equal((await call(POST)).status, 200);
  assert.equal(calls.mails.length, 1);
  assert.deepEqual(calls.transports, [
    {
      host: "smtppro.zoho.com",
      port: 465,
      secure: true,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    },
  ]);
  const [mail] = calls.mails;
  assert.equal(mail.from, `OurFaces Website <${SMTP_USER}>`);
  assert.equal(mail.to, "info@ourfaces.net");
  assert.deepEqual(mail.replyTo, {
    name: "Ada Lovelace",
    address: "ada@example.com",
  });
  assert.equal(mail.subject, "OurFaces Website Inquiry - Technology");
  assert.equal(mail.html, undefined);
  assert.equal(
    mail.text,
    [
      "New OurFaces website inquiry",
      "",
      "Name: Ada Lovelace",
      "Email: ada@example.com",
      "Organization: Analytical Engines",
      "Inquiry Type: Technology",
      "",
      "Message:",
      "Hello OurFaces.\nCould we talk?",
    ].join("\n"),
  );
});

test("a body of exactly 20,000 bytes is accepted; 20,001 bytes is refused with 413", async () => {
  const POST = await freshRoute();
  const exact = bodyOfSize(LIMIT);
  assert.equal(Buffer.byteLength(exact), LIMIT);
  assert.equal(
    (await call(POST, { body: exact, ip: "198.51.100.1" })).status,
    200,
  );
  const over = bodyOfSize(LIMIT + 1);
  assert.equal(Buffer.byteLength(over), LIMIT + 1);
  const refused = await call(POST, { body: over, ip: "198.51.100.2" });
  assert.deepEqual(refused, {
    status: 413,
    json: { error: "Request is too large." },
  });
  // Also when the body arrives as a stream with no Content-Length.
  assert.equal(
    (await call(POST, { body: streamOf(exact, 997), ip: "198.51.100.3" }))
      .status,
    200,
  );
  assert.equal(
    (await call(POST, { body: streamOf(over, 997), ip: "198.51.100.4" }))
      .status,
    413,
  );
  assert.equal(calls.mails.length, 2);
});

test("a very large streamed body is refused after reading at most the limit plus one chunk", async () => {
  const POST = await freshRoute();
  const { stream, stats } = countingStream(5 * 1024 * 1024, 16 * 1024);
  const result = await call(POST, { body: stream });
  assert.equal(result.status, 413);
  assert.ok(
    stats.pulled <= LIMIT + 2 * 16 * 1024,
    `read ${stats.pulled} bytes`,
  );
  assert.equal(calls.mails.length, 0);
});

test("an oversized stream is cancelled, not drained", async () => {
  const POST = await freshRoute();
  const { stream, stats } = countingStream(5 * 1024 * 1024, 4096);
  assert.equal((await call(POST, { body: stream })).status, 413);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stats.cancelled, true);
  const pulledAtCancel = stats.pulled;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    stats.pulled,
    pulledAtCancel,
    "nothing more is read after cancelling",
  );
  assert.ok(stats.pulled <= LIMIT + 2 * 4096, `read ${stats.pulled} bytes`);
});

test("a valid body with no Content-Length (chunked) is accepted", async () => {
  const POST = await freshRoute();
  const req = request({ body: streamOf(JSON.stringify(VALID)) });
  assert.equal(req.headers.get("content-length"), null);
  const response = await POST(req);
  assert.equal(response.status, 200);
  assert.equal(calls.mails.length, 1);
});

test("Content-Length is not trusted: an understated length cannot get a large body through", async () => {
  const POST = await freshRoute();
  const big = bodyOfSize(30_000);
  assert.equal(
    (
      await call(POST, {
        body: big,
        headers: { "content-length": "100" },
        ip: "198.51.100.1",
      })
    ).status,
    413,
  );
  const { stream, stats } = countingStream(1_000_000, 4096);
  assert.equal(
    (
      await call(POST, {
        body: stream,
        headers: { "content-length": "10" },
        ip: "198.51.100.2",
      })
    ).status,
    413,
  );
  assert.ok(stats.pulled <= LIMIT + 2 * 4096);
  // An overstated length is refused before reading; a malformed one is ignored.
  assert.equal(
    (
      await call(POST, {
        body: JSON.stringify(VALID),
        headers: { "content-length": "25000" },
        ip: "198.51.100.3",
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await call(POST, {
        body: JSON.stringify(VALID),
        headers: { "content-length": "abc" },
        ip: "198.51.100.4",
      })
    ).status,
    200,
  );
  assert.equal(calls.mails.length, 1);
});

test("unusual Content-Length values are ignored unless they are plain digits over the limit", async () => {
  const POST = await freshRoute();
  const cases = [
    ["10, 10", 200],
    ["+5", 200],
    ["-1", 200],
    ["2e4", 200],
    ["0x5000", 200],
    ["", 200],
    [" 25000 ", 413],
    ["20001", 413],
    ["99999999999999999999", 413],
  ];
  let i = 0;
  for (const [value, status] of cases) {
    i += 1;
    const result = await call(POST, {
      body: JSON.stringify(VALID),
      headers: { "content-length": value },
      ip: `198.51.100.${i}`,
    });
    assert.equal(result.status, status, JSON.stringify(value));
  }
  // Ignored values never let an oversized body through: the bytes are counted.
  const result = await call(POST, {
    body: bodyOfSize(LIMIT + 1),
    headers: { "content-length": "2e4" },
    ip: "198.51.100.99",
  });
  assert.equal(result.status, 413);
  assert.equal(calls.mails.length, 6);
});

test("malformed, empty, non-object and non-UTF-8 bodies are refused with 400 and no email", async () => {
  const POST = await freshRoute();
  const bodies = [
    "{not json",
    '{"name": "A", ',
    "",
    null,
    "   ",
    "null",
    "[]",
    JSON.stringify([VALID]),
    "42",
    '"text"',
    "true",
    new Uint8Array([
      0x7b, 0x22, 0x6e, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d,
    ]),
  ];
  let i = 0;
  for (const body of bodies) {
    i += 1;
    const result = await call(POST, { body, ip: `198.51.100.${i}` });
    assert.deepEqual(
      result,
      {
        status: 400,
        json: { error: "The request could not be read. Please try again." },
      },
      String(body),
    );
  }
  assert.equal(calls.mails.length, 0);
  assert.deepEqual(logs, []);
});

test("a body stream that fails part-way is refused with 400, not 500, and sends nothing", async () => {
  const POST = await freshRoute();
  const failing = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"name": "Ada", "email": '));
    },
    pull(controller) {
      controller.error(new Error("connection reset"));
    },
  });
  assert.deepEqual(await call(POST, { body: failing }), {
    status: 400,
    json: { error: "The request could not be read. Please try again." },
  });
  assert.equal(calls.mails.length, 0);
  assert.deepEqual(logs, []);
});

test("missing or wrongly typed required fields are refused with 400", async () => {
  const POST = await freshRoute();
  const cases = [
    {},
    { ...VALID, name: "" },
    { ...VALID, name: "   " },
    { email: VALID.email, message: VALID.message },
    { ...VALID, message: undefined },
    { ...VALID, name: 123 },
    { ...VALID, email: ["a@example.com"] },
    { ...VALID, message: { text: "hi" } },
    { ...VALID, name: null },
  ];
  let i = 0;
  for (const payload of cases) {
    i += 1;
    const result = await call(POST, {
      body: JSON.stringify(payload),
      ip: `203.0.113.${i}`,
    });
    assert.deepEqual(
      result,
      {
        status: 400,
        json: { error: "Name, email, and message are required." },
      },
      JSON.stringify(payload),
    );
  }
  assert.equal(calls.mails.length, 0);
});

test("oversized field values inside the body limit are truncated to the existing field lengths", async () => {
  const POST = await freshRoute();
  const payload = {
    ...VALID,
    name: "N".repeat(500),
    organization: "O".repeat(500),
    message: "M".repeat(9_000),
  };
  assert.equal(
    (await call(POST, { body: JSON.stringify(payload) })).status,
    200,
  );
  const { text, replyTo } = calls.mails[0];
  assert.equal(replyTo.name, "N".repeat(120));
  assert.ok(text.includes(`Organization: ${"O".repeat(160)}\n`));
  assert.ok(text.endsWith(`\n${"M".repeat(5_000)}`));
});

// --- Rate limiting ------------------------------------------------------------------------

test("five submissions per ten minutes per client: the sixth is refused with 429 and sends nothing", async () => {
  mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-02T12:00:00Z"),
  });
  const POST = await freshRoute();
  for (let i = 0; i < 5; i++)
    assert.equal((await call(POST)).status, 200, `request ${i + 1}`);
  assert.deepEqual(await call(POST), {
    status: 429,
    json: {
      error: "Too many requests. Please wait a few minutes and try again.",
    },
  });
  assert.equal(calls.mails.length, 5);
});

test("the window expires after ten minutes", async () => {
  mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-02T12:00:00Z"),
  });
  const POST = await freshRoute();
  for (let i = 0; i < 5; i++) await call(POST);
  mock.timers.tick(10 * 60 * 1000 - 1);
  assert.equal((await call(POST)).status, 429);
  mock.timers.tick(1);
  assert.equal((await call(POST)).status, 200);
});

test("different clients have separate limits", async () => {
  const POST = await freshRoute();
  for (let i = 0; i < 5; i++) await call(POST, { ip: "198.51.100.1" });
  assert.equal((await call(POST, { ip: "198.51.100.1" })).status, 429);
  assert.equal((await call(POST, { ip: "198.51.100.2" })).status, 200);
  assert.equal((await call(POST, { ip: "2001:db8:1::1" })).status, 200);
});

test("rejected requests count too: invalid and oversized attempts use up the limit", async () => {
  const POST = await freshRoute();
  await call(POST, { body: "{bad" });
  await call(POST, { body: bodyOfSize(LIMIT + 1) });
  await call(POST, { body: JSON.stringify({ ...VALID, website: "spam" }) });
  await call(POST, { body: "{}" });
  await call(POST, { body: JSON.stringify({ ...VALID, topic: "Other" }) });
  assert.equal((await call(POST)).status, 429);
  assert.equal(calls.mails.length, 0);
});

test("a rate-limited client is refused before any of its body is read", async () => {
  const POST = await freshRoute();
  for (let i = 0; i < 5; i++) await call(POST);
  const { stream, stats } = countingStream(5 * 1024 * 1024, 4096);
  // A new stream fills its queue with one chunk on its own, shortly after it
  // is created; wait for that so only reads by the route are measured.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const prefetched = stats.pulled;
  assert.equal(prefetched, 4096);
  assert.equal((await call(POST, { body: stream })).status, 429);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stats.pulled, prefetched, "the route read none of the body");
});

test("on Vercel, clients without a valid x-real-ip share one limit", async () => {
  const POST = await freshRoute();
  const ips = [
    null,
    "",
    "not-an-ip",
    "198.51.100.1, 198.51.100.2",
    "999.1.1.1",
    "unknown",
  ];
  for (const ip of ips.slice(0, 5))
    assert.equal((await call(POST, { ip })).status, 200, String(ip));
  assert.equal((await call(POST, { ip: ips[5] })).status, 429);
  // A client with a valid address is not affected.
  assert.equal((await call(POST, { ip: "198.51.100.9" })).status, 200);
});

test("forwarding headers sent by the client do not change the identity on Vercel", async () => {
  const POST = await freshRoute();
  for (let i = 0; i < 6; i++) {
    const result = await call(POST, {
      ip: "198.51.100.7",
      headers: {
        "x-forwarded-for": `203.0.113.${i}, 10.0.0.1`,
        "x-vercel-forwarded-for": `203.0.113.${i}`,
        forwarded: `for=203.0.113.${i}`,
      },
    });
    assert.equal(result.status, i < 5 ? 200 : 429, `request ${i + 1}`);
  }
});

test("outside Vercel, IP headers are ignored entirely and all requests share one limit", async () => {
  delete process.env.VERCEL;
  process.env.NODE_ENV = "production";
  const POST = await freshRoute();
  for (let i = 0; i < 6; i++) {
    const result = await call(POST, {
      ip: `203.0.113.${i}`,
      headers: { "x-forwarded-for": `198.51.100.${i}` },
    });
    assert.equal(result.status, i < 5 ? 200 : 429, `request ${i + 1}`);
  }
  // The shared limit is reported once in the server log, without any address.
  assert.equal(logs.length, 1);
  assert.match(logs[0], /not running on Vercel/);
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(logs[0]));
});

test("IPv6 clients are limited per /64; IPv4-mapped IPv6 counts as the IPv4 address", async () => {
  const POST = await freshRoute();
  // Five addresses in 2001:db8:abcd:12::/64, written in different forms.
  for (const ip of [
    "2001:db8:abcd:12::1",
    "2001:DB8:ABCD:12:ffff:ffff:ffff:ffff",
    "2001:0db8:abcd:0012:0000:0000:0000:0002",
    "2001:db8:abcd:12::3%eth0",
    "2001:db8:abcd:12:1:2:3.4.5.6",
  ])
    assert.equal((await call(POST, { ip })).status, 200, ip);
  assert.equal((await call(POST, { ip: "2001:db8:abcd:12::99" })).status, 429);
  assert.equal((await call(POST, { ip: "2001:db8:abcd:13::1" })).status, 200);

  for (let i = 0; i < 5; i++) await call(POST, { ip: "192.0.2.44" });
  assert.equal((await call(POST, { ip: "::ffff:192.0.2.44" })).status, 429);
  assert.equal((await call(POST, { ip: "::ffff:c000:22c" })).status, 429);
  assert.equal((await call(POST, { ip: "192.0.2.45" })).status, 200);
});

test("limits are per function instance: a separate instance keeps its own counts", async () => {
  const first = await freshRoute();
  for (let i = 0; i < 5; i++) await call(first);
  assert.equal((await call(first)).status, 429);
  const second = await freshRoute();
  assert.equal((await call(second)).status, 200);
});

test("memory stays bounded: at 5,000 tracked clients the oldest is dropped", async () => {
  const MAX_TRACKED = 5_000;
  const POST = await freshRoute();
  const ipv6 = (n) =>
    `2001:db8:${(n >> 16).toString(16)}:${(n & 0xffff).toString(16)}::1`;
  for (let i = 0; i < 5; i++) await call(POST, { ip: "198.51.100.1" });
  for (let n = 1; n < MAX_TRACKED; n++)
    await POST(request({ ip: ipv6(n), body: "{}" }));
  assert.equal(
    (await call(POST, { ip: "198.51.100.1" })).status,
    429,
    "still tracked at the cap",
  );
  await POST(request({ ip: ipv6(MAX_TRACKED), body: "{}" }));
  assert.equal(
    (await call(POST, { ip: "198.51.100.1" })).status,
    200,
    "dropped as the oldest",
  );
});

// --- Existing behaviour -----------------------------------------------------------------

test("honeypot: a filled website field returns success without sending", async () => {
  const POST = await freshRoute();
  const result = await call(POST, {
    body: JSON.stringify({ ...VALID, website: "https://spam.example" }),
  });
  assert.equal(result.status, 200);
  assert.equal(calls.mails.length, 0);
  assert.equal(calls.transports.length, 0);
});

test("topics: only allow-listed values; a missing topic means General Inquiry", async () => {
  const POST = await freshRoute();
  const bad = await call(POST, {
    body: JSON.stringify({ ...VALID, topic: "Crypto" }),
    ip: "198.51.100.1",
  });
  assert.deepEqual(bad, {
    status: 400,
    json: { error: "Please select a valid inquiry type." },
  });
  const missing = { ...VALID };
  delete missing.topic;
  assert.equal(
    (await call(POST, { body: JSON.stringify(missing), ip: "198.51.100.2" }))
      .status,
    200,
  );
  assert.equal(
    calls.mails[0].subject,
    "OurFaces Website Inquiry - General Inquiry",
  );
});

test("invalid email addresses are refused with 400", async () => {
  const POST = await freshRoute();
  let i = 0;
  for (const email of [
    "plainaddress",
    "a@b",
    "a b@example.com",
    "@example.com",
    "a@example.",
  ]) {
    i += 1;
    const result = await call(POST, {
      body: JSON.stringify({ ...VALID, email }),
      ip: `198.51.100.${i}`,
    });
    assert.deepEqual(
      result,
      { status: 400, json: { error: "Please enter a valid email address." } },
      email,
    );
  }
  assert.equal(calls.mails.length, 0);
});

test("missing SMTP configuration returns 503 without trying to send", async () => {
  delete process.env.ZOHO_SMTP_APP_PASSWORD;
  const POST = await freshRoute();
  assert.deepEqual(await call(POST), {
    status: 503,
    json: {
      error:
        "The contact form is temporarily unavailable. Please try again later.",
    },
  });
  assert.equal(calls.transports.length, 0);
});

test("an SMTP failure returns a generic 500 that reveals nothing about the server", async () => {
  const POST = await freshRoute();
  calls.failNext = true;
  assert.deepEqual(await call(POST), {
    status: 500,
    json: { error: "We could not send your message. Please try again later." },
  });
  assert.equal(calls.mails.length, 0);
});

test("SMTP settings come from the environment", async () => {
  process.env.ZOHO_SMTP_HOST = "smtp.example.invalid";
  process.env.ZOHO_SMTP_PORT = "587";
  process.env.CONTACT_TO_EMAIL = "inbox@example.invalid";
  const POST = await freshRoute();
  assert.equal((await call(POST)).status, 200);
  assert.deepEqual(calls.transports[0], {
    host: "smtp.example.invalid",
    port: 587,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  });
  assert.equal(calls.mails[0].to, "inbox@example.invalid");
});

test("the English and French forms send topic values the API accepts and the same JSON body", async () => {
  const form = readFileSync(FORM, "utf8");
  const values = [...form.matchAll(/\["([^"]+)", "[^"]+"\]/g)].map((m) => m[1]);
  assert.equal(values.length, 12); // six topics in each language
  const english = values.slice(0, 6);
  assert.deepEqual(values.slice(6), english);
  for (const name of [
    "name",
    "email",
    "organization",
    "topic",
    "message",
    "website",
  ])
    assert.ok(form.includes(`${name}: form.get("${name}")`), name);
  assert.ok(form.includes('"Content-Type": "application/json"'));
  // What either form sends for every topic: FormData strings, an empty honeypot.
  const POST = await freshRoute();
  let i = 0;
  for (const topic of english) {
    i += 1;
    const body = JSON.stringify({
      ...VALID,
      organization: "",
      topic,
      website: "",
    });
    assert.equal(
      (await call(POST, { body, ip: `198.51.100.${i}` })).status,
      200,
      topic,
    );
  }
  assert.equal(calls.mails.length, 6);
});
