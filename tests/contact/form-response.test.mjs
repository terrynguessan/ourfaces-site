// Contact form response handling (src/lib/contactResponse.ts, used by
// src/components/ContactForm.tsx): JSON responses from the API and non-JSON
// responses from the platform (Vercel's 413, a firewall 429) both give a clear,
// localized message, never a raw parser error. The module is loaded through
// Node's TypeScript type stripping from a temporary copy.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../../", import.meta.url);
const source = readFileSync(
  new URL("src/lib/contactResponse.ts", ROOT),
  "utf8",
);
const form = readFileSync(
  new URL("src/components/ContactForm.tsx", ROOT),
  "utf8",
);
assert.ok(source.includes('import type { Locale } from "@/lib/i18n";'));
const dir = mkdtempSync(join(tmpdir(), "ourfaces-contact-form-"));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
writeFileSync(join(dir, "contactResponse.ts"), source);
const { contactFailure } = await import(
  pathToFileURL(join(dir, "contactResponse.ts")).href
);

/** The form's own copy, read from ContactForm.tsx so the test follows it. */
function copyFor(locale) {
  const block = form.match(
    new RegExp(`\\n {2}${locale}: \\{([\\s\\S]*?)\\n {2}\\},`),
  )?.[1];
  assert.ok(block, locale);
  const value = (key) =>
    block.match(new RegExp(`\\n {4}${key}: "([^"]+)",`))?.[1];
  const copy = {
    error: value("error"),
    tooMany: value("tooMany"),
    tooLarge: value("tooLarge"),
  };
  for (const [key, text] of Object.entries(copy))
    assert.ok(text, `${locale}.${key}`);
  return copy;
}
const EN = copyFor("en");
const FR = copyFor("fr");

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const text = (status, body, type = "text/plain") =>
  new Response(body, { status, headers: { "content-type": type } });

test("the form has distinct English and French messages for errors, 429 and 413", () => {
  for (const key of ["error", "tooMany", "tooLarge"])
    assert.notEqual(EN[key], FR[key]);
  assert.equal(new Set(Object.values(EN)).size, 3);
  assert.equal(new Set(Object.values(FR)).size, 3);
});

test("an accepted message is a success in both languages", async () => {
  assert.equal(await contactFailure(json(200, { ok: true }), "en", EN), null);
  assert.equal(await contactFailure(json(200, { ok: true }), "fr", FR), null);
});

test("API errors: English shows the API's message, French its own copy for the status", async () => {
  const cases = [
    [400, "Please enter a valid email address.", FR.error],
    [413, "Request is too large.", FR.tooLarge],
    [
      429,
      "Too many requests. Please wait a few minutes and try again.",
      FR.tooMany,
    ],
    [500, "We could not send your message. Please try again later.", FR.error],
    [
      503,
      "The contact form is temporarily unavailable. Please try again later.",
      FR.error,
    ],
  ];
  for (const [status, message, french] of cases) {
    assert.equal(
      await contactFailure(json(status, { error: message }), "en", EN),
      message,
    );
    assert.equal(
      await contactFailure(json(status, { error: message }), "fr", FR),
      french,
    );
  }
});

test("non-JSON platform responses get the localized message for their status, never a parser error", async () => {
  const cases = [
    [
      413,
      text(413, "Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE\n"),
      "tooLarge",
    ],
    [
      429,
      text(429, "<!doctype html><title>429</title>", "text/html"),
      "tooMany",
    ],
    [429, text(429, ""), "tooMany"],
    [502, text(502, "Bad Gateway"), "error"],
    [500, text(500, "{truncated"), "error"],
  ];
  for (const [status, response, key] of cases) {
    const en = await contactFailure(response.clone(), "en", EN);
    const fr = await contactFailure(response, "fr", FR);
    assert.equal(en, EN[key], `en ${status}`);
    assert.equal(fr, FR[key], `fr ${status}`);
    for (const message of [en, fr])
      assert.ok(!/JSON|token|Unexpected/i.test(message), message);
  }
});

test("only a JSON { ok: true } with a 2xx status counts as sent", async () => {
  const notSent = [
    text(200, ""),
    text(200, "<html>ok</html>", "text/html"),
    json(200, { ok: false }),
    json(200, {}),
    json(200, null),
    json(200, [true]),
    json(200, "ok"),
    json(500, { ok: true }),
  ];
  for (const response of notSent)
    assert.equal(await contactFailure(response, "en", EN), EN.error);
});

test("only the boolean true counts: other truthy ok values are not a success", async () => {
  const truthy = [
    1,
    "true",
    "yes",
    "ok",
    {},
    [],
    [true],
    { value: true },
    -1,
    "false",
  ];
  for (const ok of truthy) {
    for (const [locale, copy] of [
      ["en", EN],
      ["fr", FR],
    ]) {
      const message = await contactFailure(json(200, { ok }), locale, copy);
      assert.equal(message, copy.error, `${locale} ok: ${JSON.stringify(ok)}`);
    }
  }
  // A truthy ok next to an error is still a failure, with the API's message in English.
  assert.equal(
    await contactFailure(json(200, { ok: 1, error: "Not sent." }), "en", EN),
    "Not sent.",
  );
  assert.equal(await contactFailure(json(200, { ok: true }), "en", EN), null);
});

test("unexpected error values fall back to the form's own copy", async () => {
  assert.equal(
    await contactFailure(json(429, { error: 42 }), "en", EN),
    EN.tooMany,
  );
  assert.equal(
    await contactFailure(json(400, { error: "" }), "en", EN),
    EN.error,
  );
  assert.equal(
    await contactFailure(json(413, { error: ["x"] }), "en", EN),
    EN.tooLarge,
  );
});

test("the form uses this handling and never displays a raw error message", () => {
  assert.ok(
    form.includes('import { contactFailure } from "@/lib/contactResponse";'),
  );
  assert.ok(form.includes("await contactFailure(response, locale, t)"));
  assert.ok(
    !form.includes("response.json()"),
    "the form no longer parses responses itself",
  );
  assert.ok(!/error\.message/.test(form), "no raw error text is shown");
  assert.match(
    form,
    /\} catch \{\n[^\n]*\n\s+setSubmitState\("error"\);\n\s+setStatusMessage\(t\.error\);/,
  );
});
