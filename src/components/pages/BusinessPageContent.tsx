import Link from "next/link";
import SectionHeading from "@/components/SectionHeading";
import ContactCta from "@/components/ContactCta";
import PageIdentityVisual from "@/components/PageIdentityVisual";
import type { Locale } from "@/lib/i18n";
import { localizedPath } from "@/lib/i18n";

const copy = {
  en: {
    kicker: "Business",
    title: "Connecting ideas, capabilities, and opportunities.",
    lead: "OurFaces explores business relationships, partnerships, and market opportunities with a practical, long-term approach.",
    support: "Thoughtful partnerships. Practical opportunities. Long-term value.",
    start: "Start a Conversation",
    areasKicker: "Areas of interest",
    areasTitle: "Where opportunity can take shape.",
    areasCopy: "We remain open to business opportunities that align with our capabilities, values, and long-term direction.",
    partnerships: "Partnerships",
    partnershipsCopy: "Build relationships with organizations, entrepreneurs, suppliers, and collaborators where there is a clear opportunity to create mutual value.",
    markets: "Market Opportunities",
    marketsCopy: "Explore opportunities that connect products, services, ideas, and markets in a practical and sustainable way.",
    development: "Business Development",
    developmentCopy: "Evaluate opportunities carefully, with attention to fit, feasibility, timing, and long-term potential.",
    approachKicker: "Our business approach",
    approachTitle: "Our Business Approach",
    relationships: "Relationships first",
    relationshipsCopy: "Strong business opportunities often begin with understanding the people, needs, and goals involved.",
    growth: "Measured growth",
    growthCopy: "We prefer thoughtful, sustainable growth over expansion for its own sake.",
    internationalKicker: "International perspective",
    internationalTitle: "Open to opportunities across markets.",
    internationalCopy: "OurFaces maintains an international outlook and remains open to opportunities that bring together business, products, services, and partnerships across markets.",
    africantilles: "Africantilles",
    africantillesTitle: "Explore Africantilles",
    africantillesCopy: "Africantilles is intended to serve as the customer-facing destination for selected products and future commercial offerings.",
    comingSoon: "Coming Soon",
    lookForKicker: "What we look for",
    lookForTitle: "Good fit matters.",
    qualitiesLabel: "Opportunity qualities",
    practical: "Practical",
    mutuallyBeneficial: "Mutually beneficial",
    sustainable: "Sustainable",
    aligned: "Aligned with long-term value",
    ctaTitle: "Have a business opportunity to discuss?",
    ctaCopy: "If you are exploring a partnership, market opportunity, sourcing relationship, or other business collaboration, we welcome the conversation.",
  },
  fr: {
    kicker: "Activités commerciales",
    title: "Relier les idées, les capacités et les opportunités.",
    lead: "OurFaces explore des relations d’affaires, des partenariats et des opportunités de marché selon une approche pratique et axée sur le long terme.",
    support: "Des partenariats réfléchis. Des opportunités concrètes. Une valeur à long terme.",
    start: "Échanger avec nous",
    areasKicker: "Domaines d’intérêt",
    areasTitle: "Là où les opportunités peuvent prendre forme.",
    areasCopy: "Nous restons ouverts aux opportunités commerciales qui correspondent à nos capacités, à nos valeurs et à notre orientation à long terme.",
    partnerships: "Partenariats",
    partnershipsCopy: "Établir des relations avec des organisations, des entrepreneurs, des fournisseurs et des collaborateurs lorsqu’il existe une véritable possibilité de créer une valeur mutuelle.",
    markets: "Opportunités de marché",
    marketsCopy: "Explorer des opportunités qui relient produits, services, idées et marchés de manière pratique et durable.",
    development: "Développement commercial",
    developmentCopy: "Évaluer les opportunités avec soin, en tenant compte de leur adéquation, de leur faisabilité, du moment choisi et de leur potentiel à long terme.",
    approachKicker: "Notre approche commerciale",
    approachTitle: "Notre approche commerciale",
    relationships: "Les relations d’abord",
    relationshipsCopy: "Les bonnes opportunités commerciales commencent souvent par une compréhension des personnes, des besoins et des objectifs concernés.",
    growth: "Une croissance maîtrisée",
    growthCopy: "Nous privilégions une croissance réfléchie et durable plutôt qu’une expansion pour elle-même.",
    internationalKicker: "Perspective internationale",
    internationalTitle: "Ouverts aux opportunités sur différents marchés.",
    internationalCopy: "OurFaces conserve une perspective internationale et reste ouvert aux opportunités qui réunissent activités commerciales, produits, services et partenariats sur différents marchés.",
    africantilles: "Africantilles",
    africantillesTitle: "Découvrir Africantilles",
    africantillesCopy: "Africantilles est destiné à servir de vitrine pour certains produits et de futures offres commerciales.",
    comingSoon: "Bientôt disponible",
    lookForKicker: "Ce que nous recherchons",
    lookForTitle: "L’adéquation est essentielle.",
    qualitiesLabel: "Qualités recherchées",
    practical: "Pratique",
    mutuallyBeneficial: "Mutuellement avantageux",
    sustainable: "Durable",
    aligned: "Axé sur la valeur à long terme",
    ctaTitle: "Vous souhaitez discuter d’une opportunité commerciale ?",
    ctaCopy: "Si vous explorez un partenariat, une opportunité de marché, une relation d’approvisionnement ou une autre forme de collaboration commerciale, nous serons heureux d’en discuter avec vous.",
  },
} as const;

export default function BusinessPageContent({ locale }: { locale: Locale }) {
  const t = copy[locale];

  return (
    <>
      <section className="shell page-hero page-hero-with-visual">
        <div className="page-hero-inner">
          <div className="kicker">{t.kicker}</div>
          <h1>{t.title}</h1>
          <p className="lead">{t.lead}</p>
          <p className="support-line">{t.support}</p>
          <div className="inline-actions">
            <Link className="btn btn-primary" href={localizedPath(locale, "/contact")}>{t.start}</Link>
          </div>
        </div>
        <PageIdentityVisual variant="business" locale={locale} />
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker={t.areasKicker} title={t.areasTitle} copy={<p>{t.areasCopy}</p>} />
        <div className="card-grid three">
          <article className="info-card simple-card"><h3>{t.partnerships}</h3><p>{t.partnershipsCopy}</p></article>
          <article className="info-card simple-card"><h3>{t.markets}</h3><p>{t.marketsCopy}</p></article>
          <article className="info-card simple-card"><h3>{t.development}</h3><p>{t.developmentCopy}</p></article>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker={t.approachKicker} title={t.approachTitle} />
        <div className="panel-grid">
          <article className="panel"><h3>{t.relationships}</h3><p>{t.relationshipsCopy}</p></article>
          <article className="panel"><h3>{t.growth}</h3><p>{t.growthCopy}</p></article>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="feature-panel">
          <div className="kicker">{t.internationalKicker}</div>
          <h2>{t.internationalTitle}</h2>
          <p>{t.internationalCopy}</p>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="feature-panel">
          <div className="kicker">{t.africantilles}</div>
          <h2>{t.africantillesTitle}</h2>
          <p>{t.africantillesCopy}</p>
          <div className="inline-actions">
            <span className="btn btn-secondary btn-disabled" aria-disabled="true">{t.comingSoon}</span>
          </div>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker={t.lookForKicker} title={t.lookForTitle} />
        <div className="opportunity-list" aria-label={t.qualitiesLabel}>
          <div>{t.practical}</div>
          <div>{t.mutuallyBeneficial}</div>
          <div>{t.sustainable}</div>
          <div>{t.aligned}</div>
        </div>
      </section>

      <ContactCta title={t.ctaTitle} locale={locale}>{t.ctaCopy}</ContactCta>
    </>
  );
}
