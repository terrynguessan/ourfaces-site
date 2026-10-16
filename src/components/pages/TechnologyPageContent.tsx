import Link from "next/link";
import SectionHeading from "@/components/SectionHeading";
import ContactCta from "@/components/ContactCta";
import PageIdentityVisual from "@/components/PageIdentityVisual";
import type { Locale } from "@/lib/i18n";
import { localizedPath } from "@/lib/i18n";

const copy = {
  en: {
    kicker: "Technology Solutions",
    title: "Practical technology for real-world needs.",
    lead: "OurFaces explores practical software solutions designed to improve workflows, organize information, support better decision-making, and reduce unnecessary manual work.",
    support: "Thoughtful solutions. Practical implementation. Long-term value.",
    start: "Start a Conversation",
    focusKicker: "What we focus on",
    focusTitle: "Technology with a practical purpose.",
    focusCopy: "We focus on areas where technology can simplify work, improve access to information, and support more effective processes.",
    workflowTitle: "Workflow Improvement",
    workflowCopy: "Identify repetitive or inefficient processes and explore practical ways to simplify, organize, or automate them.",
    knowledgeTitle: "Information & Knowledge",
    knowledgeCopy: "Structure information so it is easier to find, understand, maintain, and use when it matters.",
    decisionTitle: "Decision Support",
    decisionCopy: "Develop tools that help present relevant information clearly and support informed decisions.",
    aiTitle: "Applied AI",
    aiCopy: "Explore responsible uses of artificial intelligence where it can improve efficiency, knowledge access, and user experience.",
    thinkKicker: "How we think",
    thinkTitle: "How We Think About Solutions",
    problemTitle: "Start with the problem",
    problemCopy: "Technology should serve a clear purpose. We begin by understanding the need, the workflow, and the people involved before considering the solution.",
    usefulTitle: "Build for usefulness",
    usefulCopy: "A solution should be understandable, maintainable, and appropriate for the environment in which it will be used.",
    principlesKicker: "Our technology principles",
    principlesTitle: "Our Technology Principles",
    practical: "Practical",
    practicalCopy: "Solve a real need.",
    simple: "Simple",
    simpleCopy: "Avoid unnecessary complexity.",
    maintainable: "Maintainable",
    maintainableCopy: "Build with long-term usability in mind.",
    responsible: "Responsible",
    responsibleCopy: "Use technology, including AI, thoughtfully and appropriately.",
    solutionsKicker: "Solutions",
    solutionsTitle: "Solutions",
    comingTitle: "Solutions coming soon",
    comingCopy: "OurFaces is developing its technology capabilities with a focus on practical, useful applications. Published solutions will be featured here as they become available.",
    insightsKicker: "Insights",
    insightsTitle: "Learning informs better solutions.",
    insightsCopy: "OurFaces follows emerging technologies, development practices, and tools with an emphasis on what is practical, useful, and worth understanding.",
    exploreInsights: "Explore Insights →",
    ctaTitle: "Have a technology need or idea?",
    ctaCopy: "If you are exploring a workflow challenge, information problem, or opportunity where technology may help, we welcome the conversation.",
  },
  fr: {
    kicker: "Solutions technologiques",
    title: "Une technologie pratique pour des besoins concrets.",
    lead: "OurFaces explore des solutions logicielles pratiques conçues pour améliorer les flux de travail, organiser l’information, faciliter de meilleures décisions et réduire les tâches manuelles inutiles.",
    support: "Des solutions réfléchies. Une mise en œuvre pratique. Une valeur à long terme.",
    start: "Échanger avec nous",
    focusKicker: "Nos priorités",
    focusTitle: "Une technologie au service d’un objectif concret.",
    focusCopy: "Nous nous concentrons sur les domaines où la technologie peut simplifier le travail, améliorer l’accès à l’information et favoriser des processus plus efficaces.",
    workflowTitle: "Amélioration des flux de travail",
    workflowCopy: "Repérer les processus répétitifs ou inefficaces et explorer des moyens pratiques de les simplifier, de les organiser ou de les automatiser.",
    knowledgeTitle: "Information et connaissances",
    knowledgeCopy: "Structurer l’information afin qu’elle soit plus facile à trouver, à comprendre, à maintenir et à utiliser au moment opportun.",
    decisionTitle: "Aide à la décision",
    decisionCopy: "Développer des outils qui présentent clairement les informations pertinentes et favorisent des décisions éclairées.",
    aiTitle: "IA appliquée",
    aiCopy: "Explorer des usages responsables de l’intelligence artificielle lorsqu’elle peut améliorer l’efficacité, l’accès aux connaissances et l’expérience utilisateur.",
    thinkKicker: "Notre réflexion",
    thinkTitle: "Notre façon d’aborder les solutions",
    problemTitle: "Partir du problème",
    problemCopy: "La technologie doit servir un objectif clair. Nous commençons par comprendre le besoin, le flux de travail et les personnes concernées avant d’envisager la solution.",
    usefulTitle: "Concevoir pour être utile",
    usefulCopy: "Une solution doit être compréhensible, facile à maintenir et adaptée à l’environnement dans lequel elle sera utilisée.",
    principlesKicker: "Nos principes technologiques",
    principlesTitle: "Nos principes technologiques",
    practical: "Pratique",
    practicalCopy: "Répondre à un besoin réel.",
    simple: "Simple",
    simpleCopy: "Éviter toute complexité inutile.",
    maintainable: "Maintenable",
    maintainableCopy: "Concevoir en pensant à l’utilisation à long terme.",
    responsible: "Responsable",
    responsibleCopy: "Utiliser la technologie, y compris l’IA, avec discernement et de manière appropriée.",
    solutionsKicker: "Solutions",
    solutionsTitle: "Solutions",
    comingTitle: "Solutions à venir",
    comingCopy: "OurFaces développe ses capacités technologiques en mettant l’accent sur des applications pratiques et utiles. Les solutions publiées seront présentées ici dès qu’elles seront disponibles.",
    insightsKicker: "Perspectives",
    insightsTitle: "L’apprentissage nourrit de meilleures solutions.",
    insightsCopy: "OurFaces suit les technologies émergentes, les pratiques de développement et les outils en privilégiant ce qui est pratique, utile et mérite d’être compris.",
    exploreInsights: "Découvrir les perspectives →",
    ctaTitle: "Vous avez un besoin ou une idée technologique ?",
    ctaCopy: "Si vous explorez un défi lié aux flux de travail, un problème d’information ou une opportunité où la technologie pourrait aider, nous serons heureux d’en discuter avec vous.",
  },
} as const;

export default function TechnologyPageContent({ locale }: { locale: Locale }) {
  const t = copy[locale];

  return (
    <div lang={locale}>
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
        <PageIdentityVisual variant="technology" locale={locale} />
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker={t.focusKicker} title={t.focusTitle} copy={<p>{t.focusCopy}</p>} />
        <div className="card-grid four">
          <article className="info-card simple-card"><h3>{t.workflowTitle}</h3><p>{t.workflowCopy}</p></article>
          <article className="info-card simple-card"><h3>{t.knowledgeTitle}</h3><p>{t.knowledgeCopy}</p></article>
          <article className="info-card simple-card"><h3>{t.decisionTitle}</h3><p>{t.decisionCopy}</p></article>
          <article className="info-card simple-card"><h3>{t.aiTitle}</h3><p>{t.aiCopy}</p></article>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker={t.thinkKicker} title={t.thinkTitle} />
        <div className="panel-grid">
          <article className="panel"><h3>{t.problemTitle}</h3><p>{t.problemCopy}</p></article>
          <article className="panel"><h3>{t.usefulTitle}</h3><p>{t.usefulCopy}</p></article>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker={t.principlesKicker} title={t.principlesTitle} />
        <div className="principles">
          <div className="principle"><strong>{t.practical}</strong><span>{t.practicalCopy}</span></div>
          <div className="principle"><strong>{t.simple}</strong><span>{t.simpleCopy}</span></div>
          <div className="principle"><strong>{t.maintainable}</strong><span>{t.maintainableCopy}</span></div>
          <div className="principle"><strong>{t.responsible}</strong><span>{t.responsibleCopy}</span></div>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker={t.solutionsKicker} title={t.solutionsTitle} />
        <div className="placeholder-box">
          <h3>{t.comingTitle}</h3>
          <p>{t.comingCopy}</p>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="feature-panel">
          <div className="kicker">{t.insightsKicker}</div>
          <h2>{t.insightsTitle}</h2>
          <p>{t.insightsCopy}</p>
          <div className="inline-actions">
            <Link className="btn btn-secondary" href={localizedPath(locale, "/insights")}>{t.exploreInsights}</Link>
          </div>
        </div>
      </section>

      <ContactCta title={t.ctaTitle} locale={locale}>{t.ctaCopy}</ContactCta>
    </div>
  );
}
