"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { localeFromPathname, localizedPath } from "@/lib/i18n";

export default function Footer() {
  const year = new Date().getFullYear();
  const locale = localeFromPathname(usePathname());

  const legalLinks = locale === "fr"
    ? [
        { href: "/privacy", label: "Confidentialité" },
        { href: "/accessibility", label: "Accessibilité" },
        { href: "/disclaimer", label: "Avis de non-responsabilité" },
      ]
    : [
        { href: "/privacy", label: "Privacy" },
        { href: "/accessibility", label: "Accessibility" },
        { href: "/disclaimer", label: "Disclaimer" },
      ];

  return (
    <footer className="site-footer" lang={locale}>
      <div className="shell footer-row">
        <div>© {year} OurFaces Import &amp; Export, LLC</div>
        <div>
          {locale === "fr"
            ? "Solutions technologiques • Opportunités commerciales • Perspectives"
            : "Technology solutions • Business opportunities • Insights"}
        </div>
      </div>
      <nav className="shell footer-legal" aria-label={locale === "fr" ? "Informations juridiques" : "Legal information"}>
        {legalLinks.map((link) => (
          <Link key={link.href} href={localizedPath(locale, link.href)}>
            {link.label}
          </Link>
        ))}
      </nav>
    </footer>
  );
}
