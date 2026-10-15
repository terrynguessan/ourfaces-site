export type Locale = "en" | "fr";

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
