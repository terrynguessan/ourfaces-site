import Link from "next/link";
import EarthVisual from "@/components/EarthVisual";
import SectionHeading from "@/components/SectionHeading";
import ContactCta from "@/components/ContactCta";
import type { Locale } from "@/lib/i18n";
import { localizedPath } from "@/lib/i18n";

const copy = {
  en: {
    eyebrow: "Building what comes next",
    titleFirst: "Ideas into",
    titleAccent: "solutions.",
    titleSecond: "Markets into connections.",
    heroCopy: "OurFaces develops practical technology solutions, explores business opportunities, and shares useful insights on emerging technologies and modern development practices.",
    exploreWhatWeDo: "Explore What We Do",
    contactUs: "Contact Us",
    whatWeDo: "What we do",
    capabilitiesFirst: "Practical capabilities.",
    capabilitiesSecond: "Meaningful opportunities.",
    capabilitiesCopy: "OurFaces focuses on practical problem-solving, thoughtful use of technology, and business opportunities that can create lasting value.",
    technologySolutions: "Technology Solutions",
    technologySolutionsCopy: "We explore practical software solutions designed to improve workflows, organize information, support better decision-making, and reduce unnecessary manual work.",
    exploreTechnology: "Explore Technology →",
    businessOpportunities: "Business Opportunities",
    businessOpportunitiesCopy: "We explore business relationships, partnerships, and opportunities that connect ideas, capabilities, and markets.",
    exploreBusiness: "Explore Business →",
    vision: "Our Vision",
    visionCopy: "To create practical solutions and meaningful connections that help people, organizations, and markets work better.",
    mission: "Our Mission",
    missionCopy: "OurFaces combines practical technology, continuous learning, and business insight to develop useful solutions and pursue opportunities with long-term value.",
    approachKicker: "Our approach",
    approachTitle: "Our Approach",
    practicalTitle: "Practical by design",
    practicalCopy: "We focus on useful, understandable, and maintainable solutions that address real needs rather than technology for its own sake.",
    evolveTitle: "Built to evolve",
    evolveCopy: "We take a measured approach—learning, validating, and expanding capabilities as needs and opportunities develop.",
    insights: "Insights",
    ideasWorthSharing: "Ideas worth sharing.",
    insightsCopy: "OurFaces shares selected insights on emerging technologies, software development, coding practices, AI-assisted workflows, and tools worth watching.",
    insightTopicsLabel: "Insight topics",
    emergingTechnology: "Emerging Technology",
    developmentPractices: "Development Practices",
    toolsTechniques: "Tools & Techniques",
    exploreInsights: "Explore Insights",
    techBriefComing: "OurFaces Tech Brief — Coming Soon",
    aboutKicker: "About OurFaces",
    aboutTitle: "Built for practical solutions and long-term possibilities.",
    aboutCopy: "OurFaces Import & Export, LLC is a business focused on practical technology, business opportunities, and long-term value creation. We continue to evolve our capabilities while maintaining a flexible approach to future partnerships and markets.",
    aboutLink: "About OurFaces →",
    ctaTitle: "Interested in working with OurFaces?",
    ctaCopy: "Whether your interest is technology, business collaboration, partnerships, or future opportunities, we welcome the conversation.",
  },
  fr: {
    eyebrow: "Construire l’avenir",
    titleFirst: "Des idées aux",
    titleAccent: "solutions.",
    titleSecond: "Des marchés aux échanges.",
    heroCopy: "OurFaces développe des solutions technologiques pratiques, explore des opportunités commerciales et partage des analyses utiles sur les technologies émergentes et les pratiques modernes de développement.",
    exploreWhatWeDo: "Découvrir nos activités",
    contactUs: "Nous contacter",
    whatWeDo: "Ce que nous faisons",
    capabilitiesFirst: "Des capacités concrètes.",
    capabilitiesSecond: "Des opportunités porteuses.",
    capabilitiesCopy: "OurFaces met l’accent sur la résolution concrète de problèmes, l’utilisation réfléchie de la technologie et les opportunités commerciales susceptibles de créer une valeur durable.",
    technologySolutions: "Solutions technologiques",
    technologySolutionsCopy: "Nous explorons des solutions logicielles pratiques conçues pour améliorer les flux de travail, organiser l’information, faciliter de meilleures décisions et réduire les tâches manuelles inutiles.",
    exploreTechnology: "Découvrir la technologie →",
    businessOpportunities: "Opportunités commerciales",
    businessOpportunitiesCopy: "Nous explorons des relations d’affaires, des partenariats et des opportunités qui relient les idées, les capacités et les marchés.",
    exploreBusiness: "Découvrir nos activités commerciales →",
    vision: "Notre vision",
    visionCopy: "Créer des solutions pratiques et des liens utiles qui aident les personnes, les organisations et les marchés à mieux fonctionner.",
    mission: "Notre mission",
    missionCopy: "OurFaces associe technologie pratique, apprentissage continu et compréhension du monde des affaires afin de développer des solutions utiles et de saisir des opportunités créatrices de valeur à long terme.",
    approachKicker: "Notre approche",
    approachTitle: "Notre approche",
    practicalTitle: "Pensé pour être pratique",
    practicalCopy: "Nous privilégions des solutions utiles, compréhensibles et faciles à maintenir, qui répondent à des besoins réels plutôt que la technologie pour elle-même.",
    evolveTitle: "Conçu pour évoluer",
    evolveCopy: "Nous avançons avec mesure : apprendre, valider et élargir nos capacités à mesure que les besoins et les opportunités évoluent.",
    insights: "Perspectives",
    ideasWorthSharing: "Des idées qui méritent d’être partagées.",
    insightsCopy: "OurFaces partage une sélection d’analyses sur les technologies émergentes, le développement logiciel, les pratiques de programmation, les flux de travail assistés par l’IA et les outils à suivre.",
    insightTopicsLabel: "Sujets d’analyse",
    emergingTechnology: "Technologies émergentes",
    developmentPractices: "Pratiques de développement",
    toolsTechniques: "Outils et techniques",
    exploreInsights: "Découvrir les perspectives",
    techBriefComing: "OurFaces Tech Brief — Bientôt disponible",
    aboutKicker: "À propos d’OurFaces",
    aboutTitle: "Conçu pour des solutions pratiques et des possibilités à long terme.",
    aboutCopy: "OurFaces Import & Export, LLC est une entreprise axée sur la technologie pratique, les opportunités commerciales et la création de valeur à long terme. Nous continuons à développer nos capacités tout en conservant une approche souple à l’égard des futurs partenariats et marchés.",
    aboutLink: "À propos d’OurFaces →",
    ctaTitle: "Vous souhaitez travailler avec OurFaces ?",
    ctaCopy: "Que votre intérêt porte sur la technologie, la collaboration commerciale, les partenariats ou de futures opportunités, nous serons heureux d’échanger avec vous.",
  },
} as const;

export default function HomePageContent({ locale }: { locale: Locale }) {
  const t = copy[locale];

  return (
    <>
      <section className="shell home-hero">
        <div className="home-hero-copy">
          <span className="eyebrow">{t.eyebrow}</span>
          <h1 className="home-title">
            {t.titleFirst} <span className="accent">{t.titleAccent}</span><br />
            {t.titleSecond}
          </h1>
          <p className="hero-copy">{t.heroCopy}</p>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="#what-we-do">{t.exploreWhatWeDo}</Link>
            <Link className="btn btn-secondary" href={localizedPath(locale, "/contact")}>{t.contactUs}</Link>
          </div>
        </div>
        <EarthVisual locale={locale} />
      </section>

      <section className="shell content-section" id="what-we-do">
        <SectionHeading
          kicker={t.whatWeDo}
          title={<>{t.capabilitiesFirst}<br />{t.capabilitiesSecond}</>}
          copy={<p>{t.capabilitiesCopy}</p>}
        />
        <div className="card-grid two">
          <article className="info-card simple-card">
            <h3>{t.technologySolutions}</h3>
            <p>{t.technologySolutionsCopy}</p>
            <Link className="text-link" href={localizedPath(locale, "/technology")}>{t.exploreTechnology}</Link>
          </article>
          <article className="info-card simple-card">
            <h3>{t.businessOpportunities}</h3>
            <p>{t.businessOpportunitiesCopy}</p>
            <Link className="text-link" href={localizedPath(locale, "/business")}>{t.exploreBusiness}</Link>
          </article>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="green-band split-band">
          <div>
            <h3>{t.vision}</h3>
            <p>{t.visionCopy}</p>
          </div>
          <div>
            <h3>{t.mission}</h3>
            <p>{t.missionCopy}</p>
          </div>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker={t.approachKicker} title={t.approachTitle} />
        <div className="panel-grid">
          <article className="panel">
            <h3>{t.practicalTitle}</h3>
            <p>{t.practicalCopy}</p>
          </article>
          <article className="panel">
            <h3>{t.evolveTitle}</h3>
            <p>{t.evolveCopy}</p>
          </article>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="feature-panel">
          <div className="kicker">{t.insights}</div>
          <h2>{t.ideasWorthSharing}</h2>
          <p>{t.insightsCopy}</p>
          <div className="topic-strip" aria-label={t.insightTopicsLabel}>
            <div className="topic-card">{t.emergingTechnology}</div>
            <div className="topic-card">{t.developmentPractices}</div>
            <div className="topic-card">{t.toolsTechniques}</div>
          </div>
          <div className="inline-actions">
            <Link className="btn btn-primary" href={localizedPath(locale, "/insights")}>{t.exploreInsights}</Link>
            <span className="btn btn-secondary btn-disabled" aria-disabled="true">{t.techBriefComing}</span>
          </div>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker={t.aboutKicker} title={t.aboutTitle} />
        <div className="feature-panel">
          <p>{t.aboutCopy}</p>
          <div className="inline-actions">
            <Link className="btn btn-secondary" href={localizedPath(locale, "/about")}>{t.aboutLink}</Link>
          </div>
        </div>
      </section>

      <ContactCta title={t.ctaTitle} locale={locale}>{t.ctaCopy}</ContactCta>
    </>
  );
}
