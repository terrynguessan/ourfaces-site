import Link from "next/link";
import SectionHeading from "@/components/SectionHeading";
import ContactCta from "@/components/ContactCta";
import PageIdentityVisual from "@/components/PageIdentityVisual";
import type { Locale } from "@/lib/i18n";
import { localizedPath } from "@/lib/i18n";

const copy = {
  en: {
    kicker: "About OurFaces",
    title: "Practical thinking. Long-term perspective.",
    lead: "OurFaces Import & Export, LLC is a business focused on practical technology, business opportunities, and long-term value creation.",
    support: "Building capabilities thoughtfully. Pursuing opportunities with purpose.",
    whoKicker: "Who we are",
    whoTitle: "A business designed to evolve.",
    whoCopy: "OurFaces brings together practical problem-solving, technology, continuous learning, and business insight. We take a flexible approach that allows the company to develop new capabilities, explore opportunities, and grow as needs and markets evolve.",
    vision: "Our Vision",
    visionCopy: "To create practical solutions and meaningful connections that help people, organizations, and markets work better.",
    mission: "Our Mission",
    missionCopy: "OurFaces combines practical technology, continuous learning, and business insight to develop useful solutions and pursue opportunities with long-term value.",
    guidesKicker: "What guides us",
    guidesTitle: "What Guides Us",
    practicality: "Practicality",
    practicalityCopy: "Focus on useful outcomes and real needs.",
    integrity: "Integrity",
    integrityCopy: "Approach relationships, information, and opportunities responsibly.",
    learning: "Continuous Learning",
    learningCopy: "Remain curious, evaluate new ideas, and adapt as technology and business evolve.",
    longTerm: "Long-Term Value",
    longTermCopy: "Favor thoughtful decisions and sustainable opportunities over short-term activity.",
    workKicker: "How we work",
    workTitle: "How We Work",
    understand: "Understand before building",
    understandCopy: "Good solutions begin with understanding the need, the people involved, and the environment in which the solution will be used.",
    evaluate: "Evaluate before expanding",
    evaluateCopy: "Business opportunities deserve the same discipline—understand the fit, assess the value, and move forward when the conditions make sense.",
    directionKicker: "Our direction",
    directionTitle: "Built for possibilities.",
    directionCopy: "OurFaces continues to develop its technology capabilities while remaining open to business relationships, partnerships, and opportunities that align with the company’s direction and values.",
    exploreTechnology: "Explore Technology →",
    exploreBusiness: "Explore Business →",
    companyKicker: "Company information",
    companyTitle: "OurFaces Import & Export, LLC",
    company: "Company",
    companyType: "Connecticut limited liability company",
    website: "Website",
    ctaTitle: "Interested in learning more about OurFaces?",
    ctaCopy: "Whether you are exploring technology, collaboration, partnership opportunities, or another business connection, we welcome the conversation.",
  },
  fr: {
    kicker: "À propos d’OurFaces",
    title: "Une réflexion pratique. Une vision à long terme.",
    lead: "OurFaces Import & Export, LLC est une entreprise axée sur la technologie pratique, les opportunités commerciales et la création de valeur à long terme.",
    support: "Développer nos capacités avec méthode. Saisir les opportunités avec discernement.",
    whoKicker: "Qui nous sommes",
    whoTitle: "Une entreprise conçue pour évoluer.",
    whoCopy: "OurFaces réunit la résolution concrète de problèmes, la technologie, l’apprentissage continu et la compréhension du monde des affaires. Nous adoptons une approche souple qui permet à l’entreprise de développer de nouvelles capacités, d’explorer des opportunités et de progresser à mesure que les besoins et les marchés évoluent.",
    vision: "Notre vision",
    visionCopy: "Créer des solutions pratiques et des liens utiles qui aident les personnes, les organisations et les marchés à mieux fonctionner.",
    mission: "Notre mission",
    missionCopy: "OurFaces associe technologie pratique, apprentissage continu et compréhension du monde des affaires afin de développer des solutions utiles et de saisir des opportunités créatrices de valeur à long terme.",
    guidesKicker: "Ce qui nous guide",
    guidesTitle: "Ce qui nous guide",
    practicality: "Pragmatisme",
    practicalityCopy: "Se concentrer sur des résultats utiles et des besoins réels.",
    integrity: "Intégrité",
    integrityCopy: "Aborder les relations, l’information et les opportunités de manière responsable.",
    learning: "Apprentissage continu",
    learningCopy: "Rester curieux, évaluer de nouvelles idées et s’adapter à l’évolution de la technologie et des affaires.",
    longTerm: "Valeur à long terme",
    longTermCopy: "Privilégier les décisions réfléchies et les opportunités durables plutôt que l’activité à court terme.",
    workKicker: "Notre façon de travailler",
    workTitle: "Notre façon de travailler",
    understand: "Comprendre avant de construire",
    understandCopy: "Les bonnes solutions commencent par une compréhension du besoin, des personnes concernées et de l’environnement dans lequel la solution sera utilisée.",
    evaluate: "Évaluer avant de se développer",
    evaluateCopy: "Les opportunités commerciales méritent la même rigueur : comprendre l’adéquation, évaluer la valeur et avancer lorsque les conditions sont réunies.",
    directionKicker: "Notre orientation",
    directionTitle: "Conçu pour ouvrir de nouvelles possibilités.",
    directionCopy: "OurFaces continue de développer ses capacités technologiques tout en restant ouvert aux relations d’affaires, aux partenariats et aux opportunités qui correspondent à l’orientation et aux valeurs de l’entreprise.",
    exploreTechnology: "Découvrir la technologie →",
    exploreBusiness: "Découvrir nos activités commerciales →",
    companyKicker: "Informations sur l’entreprise",
    companyTitle: "OurFaces Import & Export, LLC",
    company: "Entreprise",
    companyType: "Société à responsabilité limitée (LLC) du Connecticut",
    website: "Site web",
    ctaTitle: "Vous souhaitez en savoir plus sur OurFaces ?",
    ctaCopy: "Que vous exploriez la technologie, une collaboration, des possibilités de partenariat ou une autre relation d’affaires, nous serons heureux d’échanger avec vous.",
  },
} as const;

export default function AboutPageContent({ locale }: { locale: Locale }) {
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
        <PageIdentityVisual variant="about" locale={locale} />
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker={t.whoKicker} title={t.whoTitle} />
        <div className="feature-panel"><p>{t.whoCopy}</p></div>
      </section>

      <section className="shell content-section compact">
        <div className="green-band split-band">
          <div><h3>{t.vision}</h3><p>{t.visionCopy}</p></div>
          <div><h3>{t.mission}</h3><p>{t.missionCopy}</p></div>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker={t.guidesKicker} title={t.guidesTitle} />
        <div className="card-grid four">
          <article className="info-card simple-card"><h3>{t.practicality}</h3><p>{t.practicalityCopy}</p></article>
          <article className="info-card simple-card"><h3>{t.integrity}</h3><p>{t.integrityCopy}</p></article>
          <article className="info-card simple-card"><h3>{t.learning}</h3><p>{t.learningCopy}</p></article>
          <article className="info-card simple-card"><h3>{t.longTerm}</h3><p>{t.longTermCopy}</p></article>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker={t.workKicker} title={t.workTitle} />
        <div className="panel-grid">
          <article className="panel"><h3>{t.understand}</h3><p>{t.understandCopy}</p></article>
          <article className="panel"><h3>{t.evaluate}</h3><p>{t.evaluateCopy}</p></article>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="feature-panel">
          <div className="kicker">{t.directionKicker}</div>
          <h2>{t.directionTitle}</h2>
          <p>{t.directionCopy}</p>
          <div className="inline-actions">
            <Link className="btn btn-secondary" href={localizedPath(locale, "/technology")}>{t.exploreTechnology}</Link>
            <Link className="btn btn-secondary" href={localizedPath(locale, "/business")}>{t.exploreBusiness}</Link>
          </div>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker={t.companyKicker} title={t.companyTitle} />
        <div className="company-block">
          <div className="company-card">
            <h3>{t.company}</h3>
            <div className="company-lines">
              <span>OurFaces Import &amp; Export, LLC</span>
              <span>{t.companyType}</span>
            </div>
          </div>
          <div className="company-card">
            <h3>{t.website}</h3>
            <div className="company-lines"><span>ourfaces.net</span></div>
          </div>
        </div>
      </section>

      <ContactCta title={t.ctaTitle} locale={locale}>{t.ctaCopy}</ContactCta>
    </>
  );
}
