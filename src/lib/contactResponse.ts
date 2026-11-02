import type { Locale } from "@/lib/i18n";

type FailureCopy = { error: string; tooMany: string; tooLarge: string };

// The message to show for a contact-form response, or null when the message
// was accepted. Not every response is the API's JSON: Vercel's own 413 for an
// oversized body and a firewall 429 have other bodies, so the body is read
// defensively and the status picks the message. English shows the API's own
// message when it sent one; French always uses its own copy.
export async function contactFailure(
  response: Response,
  locale: Locale,
  copy: FailureCopy,
) {
  const parsed: unknown = await response.json().catch(() => null);
  const body =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { ok?: unknown; error?: unknown })
      : {};
  if (response.ok && body.ok === true) return null;
  if (locale === "en" && typeof body.error === "string" && body.error)
    return body.error;
  if (response.status === 429) return copy.tooMany;
  if (response.status === 413) return copy.tooLarge;
  return copy.error;
}
