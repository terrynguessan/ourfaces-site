"use client";

import { usePathname } from "next/navigation";
import { localeFromPathname } from "@/lib/i18n";

export default function Footer() {
  const year = new Date().getFullYear();
  const locale = localeFromPathname(usePathname());

  return (
    <footer className="site-footer">
      <div className="shell footer-row">
        <div>© {year} OurFaces Import &amp; Export, LLC</div>
        <div>
          {locale === "fr"
            ? "Solutions technologiques • Opportunités commerciales • Perspectives"
            : "Technology solutions • Business opportunities • Insights"}
        </div>
      </div>
    </footer>
  );
}
