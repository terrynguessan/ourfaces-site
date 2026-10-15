import SectionHeading from "@/components/SectionHeading";
import ContactForm from "@/components/ContactForm";
import PageIdentityVisual from "@/components/PageIdentityVisual";
import type { Locale } from "@/lib/i18n";

const copy = {
  en: {
    kicker: "Contact OurFaces",
    title: "Start a conversation.",
    lead: "Whether your interest is technology, business collaboration, partnerships, or another opportunity, we welcome the conversation.",
    support: "Tell us what you are exploring, and we’ll take it from there.",
    directTitle: "Prefer to contact us directly?",
    directCopy: "Use the contact details below for general business inquiries.",
    email: "Email",
    phone: "Phone",
    areasKicker: "Inquiry areas",
    areasTitle: "Inquiry Areas",
    technology: "Technology",
    technologyCopy: "Workflow challenges, practical software needs, information organization, AI-related opportunities, and solution ideas.",
    business: "Business",
    businessCopy: "Partnerships, market opportunities, sourcing relationships, and other business collaborations.",
    insights: "Insights",
    insightsCopy: "Technology topics, content suggestions, knowledge-sharing, and potential collaboration around the OurFaces Tech Brief.",
    nextTitle: "What happens next",
    nextCopy: "We review each inquiry and respond when there is a clear next step or additional information is needed.",
    privacy: "Information submitted through this form will be used only to review and respond to your inquiry.",
  },
  fr: {
    kicker: "Contacter OurFaces",
    title: "Engageons la conversation.",
    lead: "Que votre intérêt porte sur la technologie, la collaboration commerciale, les partenariats ou une autre opportunité, nous serons heureux d’échanger avec vous.",
    support: "Parlez-nous de ce que vous explorez, et nous verrons ensemble la suite.",
    directTitle: "Vous préférez nous contacter directement ?",
    directCopy: "Utilisez les coordonnées ci-dessous pour les demandes commerciales générales.",
    email: "E-mail",
    phone: "Téléphone",
    areasKicker: "Domaines de demande",
    areasTitle: "Domaines de demande",
    technology: "Technologie",
    technologyCopy: "Défis liés aux flux de travail, besoins logiciels pratiques, organisation de l’information, opportunités liées à l’IA et idées de solutions.",
    business: "Affaires",
    businessCopy: "Partenariats, opportunités de marché, relations d’approvisionnement et autres collaborations commerciales.",
    insights: "Perspectives",
    insightsCopy: "Sujets technologiques, suggestions de contenu, partage de connaissances et collaborations potentielles autour du Tech Brief d’OurFaces.",
    nextTitle: "La suite",
    nextCopy: "Nous examinons chaque demande et répondons lorsqu’une prochaine étape est claire ou que des informations supplémentaires sont nécessaires.",
    privacy: "Les informations soumises au moyen de ce formulaire seront utilisées uniquement pour examiner votre demande et y répondre.",
  },
} as const;

export default function ContactPageContent({ locale }: { locale: Locale }) {
  const t = copy[locale];

  return (
    <>
      <section className="shell page-hero page-hero-with-visual">
        <div className="page-hero-inner">
          <div className="kicker">{t.kicker}</div>
          <h1>{t.title}</h1>
          <p className="lead">{t.lead}</p>
          <p className="support-line">{t.support}</p>
        </div>
        <PageIdentityVisual variant="contact" locale={locale} />
      </section>

      <section className="shell content-section compact">
        <div className="contact-layout">
          <ContactForm locale={locale} />
          <aside className="direct-contact">
            <h2>{t.directTitle}</h2>
            <p>{t.directCopy}</p>
            <dl>
              <div>
                <dt>{t.email}</dt>
                <dd><a href="mailto:info@ourfaces.net">info@ourfaces.net</a></dd>
              </div>
              <div>
                <dt>{t.phone}</dt>
                <dd><a href="tel:+18605806814">(860) 580-6814</a></dd>
              </div>
            </dl>
          </aside>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker={t.areasKicker} title={t.areasTitle} />
        <div className="inquiry-grid">
          <article className="inquiry-card"><h3>{t.technology}</h3><p>{t.technologyCopy}</p></article>
          <article className="inquiry-card"><h3>{t.business}</h3><p>{t.businessCopy}</p></article>
          <article className="inquiry-card"><h3>{t.insights}</h3><p>{t.insightsCopy}</p></article>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="note-box"><h3>{t.nextTitle}</h3><p>{t.nextCopy}</p></div>
      </section>

      <div className="shell privacy-note">{t.privacy}</div>
    </>
  );
}
