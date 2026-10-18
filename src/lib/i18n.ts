import type { Metadata } from "next";

export type Locale = "en" | "fr";

// Production origin. The apex domain 308-redirects here, so canonical and
// hreflang URLs point at www to avoid advertising redirecting URLs.
const siteUrl = "https://www.ourfaces.net";

export function localeFromPathname(pathname: string): Locale {
  return pathname === "/fr" || pathname.startsWith("/fr/") ? "fr" : "en";
}

export function stripLocalePrefix(pathname: string) {
  if (pathname === "/fr") return "/";
  if (pathname.startsWith("/fr/")) return pathname.slice(3) || "/";
  return pathname || "/";
}

export function localizedPath(locale: Locale, pathname: string) {
  const base = pathname === "" ? "/" : pathname;
  if (locale === "en") return base;
  return base === "/" ? "/fr" : `/fr${base}`;
}

export function equivalentLanguagePath(pathname: string, locale: Locale) {
  return localizedPath(locale, stripLocalePrefix(pathname));
}

/** Canonical URL plus reciprocal EN/FR hreflang links for a page.
 *  `pathname` is the English (unprefixed) path, e.g. "/technology". */
export function pageAlternates(locale: Locale, pathname: string): Metadata["alternates"] {
  const en = siteUrl + localizedPath("en", pathname);
  const fr = siteUrl + localizedPath("fr", pathname);

  return {
    canonical: locale === "en" ? en : fr,
    languages: { en, fr, "x-default": en },
  };
}
