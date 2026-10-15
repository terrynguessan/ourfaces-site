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

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

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

function getClientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

function isRateLimited(ip: string) {
  const now = Date.now();
  const current = rateLimitStore.get(ip);

  if (!current || current.resetAt <= now) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  if (current.count >= MAX_REQUESTS_PER_WINDOW) {
    return true;
  }

  current.count += 1;
  return false;
}

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }

    const ip = getClientIp(request);
    if (isRateLimited(ip)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a few minutes and try again." },
        { status: 429 }
      );
    }

    const body = (await request.json()) as ContactPayload;

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
