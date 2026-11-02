import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { NextResponse } from "next/server";
import nodemailer from "nodemailer";

export const runtime = "nodejs";

const ALLOWED_TOPICS = new Set([
  "Technology",
  "Business Opportunity",
  "Partnership / Collaboration",
  "Africantilles",
  "Insights / Tech Brief",
  "General Inquiry",
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 5;
const MAX_BODY_BYTES = 20_000;
// Upper bound on the clients tracked by one function instance; the oldest are dropped first.
const MAX_TRACKED_CLIENTS = 5_000;

// Best-effort rate limiting, per function instance: each Vercel instance keeps
// its own counts, so this is not a global limit across instances or regions.
// Keys are keyed hashes of the client's network (an IPv4 address or an IPv6
// /64 prefix) with a per-instance random secret, so raw addresses are not kept.
// Entries are kept in window-start order, so expired ones are removed from the front.
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
const rateLimitSecret = randomBytes(32);
let untrustedIpWarningShown = false;

type ContactPayload = {
  name?: unknown;
  email?: unknown;
  organization?: unknown;
  topic?: unknown;
  message?: unknown;
  website?: unknown;
};

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

// An IPv4 address, or the /64 prefix of an IPv6 address (one subscriber usually
// controls a whole /64). IPv4-mapped IPv6 addresses count as IPv4. Null if invalid.
function clientNetwork(value: string | null) {
  const ip = value?.trim() ?? "";
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version !== 6) return null;
  let address = ip.split("%")[0].toLowerCase();
  const embedded = address.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (embedded) {
    const [a, b, c, d] = embedded.slice(1).map(Number);
    address = `${address.slice(0, embedded.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = address.split("::");
  const first = head ? head.split(":") : [];
  const last = tail ? tail.split(":") : [];
  const groups = tail === undefined ? first : [...first, ...Array(8 - first.length - last.length).fill("0"), ...last];
  const words = groups.map((group) => parseInt(group, 16));
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join(".");
  }
  return `${words.slice(0, 4).map((word) => word.toString(16)).join(":")}::/64`;
}

// Client identity for rate limiting. On Vercel, x-real-ip is set by Vercel from
// the connecting client: it is identical to x-forwarded-for, which Vercel
// overwrites and does not forward from clients
// (https://vercel.com/docs/headers/request-headers). Anywhere else these headers
// can come from the client, so they are ignored. Requests without a trusted,
// valid address share one bucket, so the limit still applies to them.
function rateLimitKey(request: Request) {
  const onVercel = process.env.VERCEL === "1";
  if (!onVercel && process.env.NODE_ENV === "production" && !untrustedIpWarningShown) {
    untrustedIpWarningShown = true;
    console.warn("Contact form: not running on Vercel, so client IP headers are not trusted; one shared rate limit applies.");
  }
  const network = onVercel ? clientNetwork(request.headers.get("x-real-ip")) : null;
  return createHmac("sha256", rateLimitSecret)
    .update(network ?? "unidentified")
    .digest("base64url");
}

function isRateLimited(key: string) {
  const now = Date.now();
  for (const [storedKey, entry] of rateLimitStore) {
    if (entry.resetAt > now) break;
    rateLimitStore.delete(storedKey);
  }

  const current = rateLimitStore.get(key);
  if (!current || current.resetAt <= now) {
    rateLimitStore.delete(key);
    if (rateLimitStore.size >= MAX_TRACKED_CLIENTS) {
      const oldest = rateLimitStore.keys().next().value;
      if (oldest !== undefined) rateLimitStore.delete(oldest);
    }
    rateLimitStore.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  if (current.count >= MAX_REQUESTS_PER_WINDOW) {
    return true;
  }

  current.count += 1;
  return false;
}

type BodyResult = { payload: ContactPayload } | { status: 400 | 413 };

// Reads at most MAX_BODY_BYTES of the actual body, whatever Content-Length
// declares, and stops reading as soon as the limit is passed. Only a JSON
// object is accepted.
async function readJsonBody(request: Request): Promise<BodyResult> {
  const declared = request.headers.get("content-length")?.trim();
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
    return { status: 413 };
  }
  if (!request.body) {
    return { status: 400 };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        reader.cancel().catch(() => {});
        return { status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { status: 400 };
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { status: 400 };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: 400 };
  }
  return { payload: parsed as ContactPayload };
}

export async function POST(request: Request) {
  try {
    if (isRateLimited(rateLimitKey(request))) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a few minutes and try again." },
        { status: 429 }
      );
    }

    const result = await readJsonBody(request);
    if ("status" in result) {
      return result.status === 413
        ? NextResponse.json({ error: "Request is too large." }, { status: 413 })
        : NextResponse.json({ error: "The request could not be read. Please try again." }, { status: 400 });
    }
    const body = result.payload;

    // Honeypot: normal visitors never fill this field.
    if (cleanText(body.website, 200)) {
      return NextResponse.json({ ok: true });
    }

    const name = cleanText(body.name, 120);
    const email = cleanText(body.email, 254).toLowerCase();
    const organization = cleanText(body.organization, 160);
    const topic = cleanText(body.topic, 80) || "General Inquiry";
    const message = cleanText(body.message, 5_000);

    if (!name || !email || !message) {
      return NextResponse.json(
        { error: "Name, email, and message are required." },
        { status: 400 }
      );
    }

    if (!EMAIL_PATTERN.test(email)) {
      return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
    }

    if (!ALLOWED_TOPICS.has(topic)) {
      return NextResponse.json({ error: "Please select a valid inquiry type." }, { status: 400 });
    }

    const host = process.env.ZOHO_SMTP_HOST || "smtppro.zoho.com";
    const port = Number(process.env.ZOHO_SMTP_PORT || 465);
    const user = process.env.ZOHO_SMTP_USER;
    const password = process.env.ZOHO_SMTP_APP_PASSWORD;
    const to = process.env.CONTACT_TO_EMAIL || "info@ourfaces.net";

    if (!user || !password) {
      console.error("Contact form email configuration is incomplete.");
      return NextResponse.json(
        { error: "The contact form is temporarily unavailable. Please try again later." },
        { status: 503 }
      );
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: {
        user,
        pass: password,
      },
    });

    // Send a single-part plain-text message. This avoids multipart MIME
    // rendering issues in some mail clients while keeping replies directed
    // to the person who submitted the form.
    await transporter.sendMail({
      from: `OurFaces Website <${user}>`,
      to,
      replyTo: { name, address: email },
      subject: `OurFaces Website Inquiry - ${topic}`,
      text: [
        "New OurFaces website inquiry",
        "",
        `Name: ${name}`,
        `Email: ${email}`,
        `Organization: ${organization || "Not provided"}`,
        `Inquiry Type: ${topic}`,
        "",
        "Message:",
        message,
      ].join("\n"),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Contact form submission failed:", error);
    return NextResponse.json(
      { error: "We could not send your message. Please try again later." },
      { status: 500 }
    );
  }
}
