import Link from "next/link";
import type { Locale } from "@/lib/i18n";
import { localizedPath } from "@/lib/i18n";

type Props = {
  title: string;
  children: React.ReactNode;
  locale?: Locale;
};

export default function ContactCta({ title, children, locale = "en" }: Props) {
  return (
    <section
      className="shell contact-cta-wrap"
      aria-label={locale === "fr" ? "Contacter OurFaces" : "Contact OurFaces"}
    >
      <div className="contact-cta">
        <div>
          <div className="kicker kicker-gold">OurFaces Import &amp; Export, LLC</div>
          <h2>{title}</h2>
          <p>{children}</p>
        </div>
        <Link className="btn btn-light" href={localizedPath(locale, "/contact")}>
          {locale === "fr" ? "Contacter OurFaces" : "Contact OurFaces"}
        </Link>
      </div>
    </section>
  );
}
