import Link from "next/link";
import SectionHeading from "@/components/SectionHeading";
import ContactCta from "@/components/ContactCta";
import PageIdentityVisual from "@/components/PageIdentityVisual";
import type { Locale } from "@/lib/i18n";
import { localizedPath } from "@/lib/i18n";
import type { TechBriefCategory } from "@/lib/techBrief";
import { formatEditionDate, getLatestEdition } from "@/lib/techBrief";

const copy = {
  en: {
    kicker: "Insights",
    title: "Useful ideas. Practical perspective.",
    lead: "OurFaces shares selected insights on emerging technologies, software development, coding practices, AI-assisted workflows, and tools worth understanding.",
    support: "Curated for relevance, clarity, and practical value.",
    exploreTopics: "Explore Topics",
    coverKicker: "What we cover",
    coverTitle: "Topics worth following.",
    emergingTitle: "Emerging Technology",
    emergingCopy: "Developments in artificial intelligence, software platforms, infrastructure, and other technologies that may shape how people and organizations work.",
    developmentTitle: "Development Practices",
    developmentCopy: "Practical approaches to software design, testing, maintainability, deployment, and responsible development.",
    toolsTitle: "Tools & Techniques",
    toolsCopy: "Selected tools, frameworks, coding techniques, and workflows that may improve productivity or software quality.",
    aiTitle: "Applied AI",
    aiCopy: "Practical uses of AI in development, knowledge work, automation, decision support, and other real-world applications.",
    editorialKicker: "Our editorial approach",
    editorialTitle: "Our Editorial Approach",
    curatedTitle: "Curated, not crowded",
    curatedCopy: "We focus on selected topics that appear useful, relevant, or worth understanding rather than trying to cover every technology trend.",
    practicalTitle: "Practical over promotional",
    practicalCopy: "The goal is to highlight ideas, techniques, and tools that can be evaluated and applied in real-world work.",
    featuredKicker: "Featured Insights",
    featuredTitle: "Featured Insights",
    featuredCopy: "New articles and technology notes will be added as they are published.",
    featuredLabel: "Featured insight categories",
    trend: "Technology Trends",
    development: "Development Practices",
    tools: "Tools Worth Watching",
    briefKicker: "OurFaces Tech Brief",
    briefTitle: "A concise look at technology worth knowing.",
    briefCopy: "The OurFaces Tech Brief will bring together selected technology developments, coding practices, useful tools, and practical lessons in a concise format.",
    worthKnowing: "Worth Knowing",
    worthKnowingCopy: "A development or idea worth understanding.",
    worthTrying: "Worth Trying",
    worthTryingCopy: "A tool, technique, or workflow that may deserve experimentation.",
    betterPractice: "Better Practice",
    betterPracticeCopy: "A practical software-development or engineering principle.",
    watchList: "On the Watch List",
    watchListCopy: "An emerging technology or trend worth monitoring.",
    briefComing: "Tech Brief coming soon",
    briefEditionTitle: "This week’s brief",
    briefStoriesLabel: "This week’s Tech Brief stories",
    briefWhyItMatters: "Why it matters:",
    briefSource: "Source:",
    learningKicker: "From learning to practice",
    learningTitle: "Learning should lead to better solutions.",
    learningCopy: "Following technology is most useful when it improves how problems are understood and how solutions are designed. OurFaces approaches learning with practical application in mind.",
    exploreTechnology: "Explore Technology Solutions →",
    ctaTitle: "Have an idea or topic worth discussing?",
    ctaCopy: "If you would like to share a technology perspective, suggest a topic, or explore a related collaboration, we welcome the conversation.",
  },
  fr: {
    kicker: "Perspectives",
    title: "Des idées utiles. Une perspective pratique.",
    lead: "OurFaces partage une sélection d’analyses sur les technologies émergentes, le développement logiciel, les pratiques de programmation, les flux de travail assistés par l’IA et les outils qui méritent qu’on s’y intéresse.",
    support: "Sélectionnées pour leur pertinence, leur clarté et leur valeur pratique.",
    exploreTopics: "Découvrir les sujets",
    coverKicker: "Nos sujets",
    coverTitle: "Des sujets qui méritent d’être suivis.",
    emergingTitle: "Technologies émergentes",
    emergingCopy: "Les évolutions de l’intelligence artificielle, des plateformes logicielles, de l’infrastructure et d’autres technologies susceptibles de transformer la façon dont les personnes et les organisations travaillent.",
    developmentTitle: "Pratiques de développement",
    developmentCopy: "Des approches pratiques de la conception logicielle, des tests, de la maintenabilité, du déploiement et du développement responsable.",
    toolsTitle: "Outils et techniques",
    toolsCopy: "Une sélection d’outils, de frameworks, de techniques de programmation et de flux de travail pouvant améliorer la productivité ou la qualité logicielle.",
    aiTitle: "IA appliquée",
    aiCopy: "Des usages pratiques de l’IA dans le développement, le travail intellectuel, l’automatisation, l’aide à la décision et d’autres applications concrètes.",
    editorialKicker: "Notre approche éditoriale",
    editorialTitle: "Notre approche éditoriale",
    curatedTitle: "Sélectionner plutôt que surcharger",
    curatedCopy: "Nous nous concentrons sur des sujets choisis qui semblent utiles, pertinents ou dignes d’intérêt, plutôt que d’essayer de couvrir toutes les tendances technologiques.",
    practicalTitle: "La valeur pratique avant la promotion",
    practicalCopy: "L’objectif est de mettre en avant des idées, des techniques et des outils qui peuvent être évalués et appliqués dans le travail réel.",
    featuredKicker: "Analyses à la une",
    featuredTitle: "Analyses à la une",
    featuredCopy: "De nouveaux articles et notes technologiques seront ajoutés au fur et à mesure de leur publication.",
    featuredLabel: "Catégories d’analyses à la une",
    trend: "Tendances technologiques",
    development: "Pratiques de développement",
    tools: "Outils à suivre",
    briefKicker: "OurFaces Tech Brief",
    briefTitle: "Un regard concis sur les technologies à connaître.",
    briefCopy: "OurFaces Tech Brief réunira une sélection d’évolutions technologiques, de pratiques de programmation, d’outils utiles et d’enseignements pratiques dans un format concis.",
    worthKnowing: "À connaître",
    worthKnowingCopy: "Une évolution ou une idée qui mérite d’être comprise.",
    worthTrying: "À essayer",
    worthTryingCopy: "Un outil, une technique ou un flux de travail qui pourrait mériter une expérimentation.",
    betterPractice: "Bonne pratique",
    betterPracticeCopy: "Un principe pratique de développement logiciel ou d’ingénierie.",
    watchList: "À surveiller",
    watchListCopy: "Une technologie émergente ou une tendance qui mérite d’être suivie.",
    briefComing: "Tech Brief bientôt disponible",
    briefEditionTitle: "Le brief de la semaine",
    briefStoriesLabel: "Articles du Tech Brief de la semaine",
    // Non-breaking spaces keep the colon from wrapping onto its own line.
    briefWhyItMatters: "Pourquoi c’est important :",
    briefSource: "Source :",
    learningKicker: "De l’apprentissage à la pratique",
    learningTitle: "L’apprentissage doit mener à de meilleures solutions.",
    learningCopy: "Suivre la technologie est surtout utile lorsqu’elle améliore la compréhension des problèmes et la conception des solutions. OurFaces aborde l’apprentissage en gardant à l’esprit son application pratique.",
    exploreTechnology: "Découvrir les solutions technologiques →",
    ctaTitle: "Vous avez une idée ou un sujet à discuter ?",
    ctaCopy: "Si vous souhaitez partager un point de vue sur la technologie, proposer un sujet ou explorer une collaboration connexe, nous serons heureux d’échanger avec vous.",
  },
} as const;

// Story categories reuse the "What we cover" topic titles in each language.
const categoryTitleKey = {
  "emerging-technology": "emergingTitle",
  "development-practices": "developmentTitle",
  "tools-techniques": "toolsTitle",
  "applied-ai": "aiTitle",
} as const satisfies Record<TechBriefCategory, keyof (typeof copy)["en"]>;

export default function InsightsPageContent({ locale }: { locale: Locale }) {
  const t = copy[locale];
  const edition = getLatestEdition();

  return (
    <div lang={locale}>
      <section className="shell page-hero page-hero-with-visual">
        <div className="page-hero-inner">
          <div className="kicker">{t.kicker}</div>
          <h1>{t.title}</h1>
          <p className="lead">{t.lead}</p>
          <p className="support-line">{t.support}</p>
          <div className="inline-actions">
            <a className="btn btn-primary" href="#topics">{t.exploreTopics}</a>
          </div>
        </div>
        <PageIdentityVisual variant="insights" locale={locale} />
      </section>

      <section className="shell content-section compact" id="topics">
        <SectionHeading kicker={t.coverKicker} title={t.coverTitle} />
        <div className="card-grid four">
          <article className="info-card simple-card"><h3>{t.emergingTitle}</h3><p>{t.emergingCopy}</p></article>
          <article className="info-card simple-card"><h3>{t.developmentTitle}</h3><p>{t.developmentCopy}</p></article>
          <article className="info-card simple-card"><h3>{t.toolsTitle}</h3><p>{t.toolsCopy}</p></article>
          <article className="info-card simple-card"><h3>{t.aiTitle}</h3><p>{t.aiCopy}</p></article>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker={t.editorialKicker} title={t.editorialTitle} />
        <div className="panel-grid">
          <article className="panel"><h3>{t.curatedTitle}</h3><p>{t.curatedCopy}</p></article>
          <article className="panel"><h3>{t.practicalTitle}</h3><p>{t.practicalCopy}</p></article>
        </div>
      </section>

      <section className="shell content-section compact">
        <SectionHeading kicker={t.featuredKicker} title={t.featuredTitle} />
        <div className="placeholder-box">
          <p>{t.featuredCopy}</p>
          <div className="topic-strip" aria-label={t.featuredLabel}>
            <div className="topic-card">{t.trend}</div>
            <div className="topic-card">{t.development}</div>
            <div className="topic-card">{t.tools}</div>
          </div>
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="green-band">
          <div className="kicker kicker-gold">{t.briefKicker}</div>
          <h2 className="panel-title">{t.briefTitle}</h2>
          <p>{t.briefCopy}</p>
          <div className="tech-brief-grid">
            <div className="brief-item"><strong>{t.worthKnowing}</strong><span>{t.worthKnowingCopy}</span></div>
            <div className="brief-item"><strong>{t.worthTrying}</strong><span>{t.worthTryingCopy}</span></div>
            <div className="brief-item"><strong>{t.betterPractice}</strong><span>{t.betterPracticeCopy}</span></div>
            <div className="brief-item"><strong>{t.watchList}</strong><span>{t.watchListCopy}</span></div>
          </div>
          {edition ? (
            <div className="tech-brief-edition" data-edition={edition.edition}>
              <h3 className="tech-brief-edition-title">
                {t.briefEditionTitle} · <time dateTime={edition.publishedOn}>{formatEditionDate(edition.publishedOn, locale)}</time>
              </h3>
              <ol className="tech-brief-stories" aria-label={t.briefStoriesLabel}>
                {edition.stories.map((story) => (
                  <li key={story.id} className="brief-item tech-brief-story">
                    <span className="tech-brief-category">{t[categoryTitleKey[story.category]]}</span>
                    <h4>{story[locale].headline}</h4>
                    <p>{story[locale].summary}</p>
                    <p><span className="tech-brief-label">{t.briefWhyItMatters}</span> {story[locale].whyItMatters}</p>
                    <p className="tech-brief-source">
                      {t.briefSource}{" "}
                      <a href={story.url} rel="noopener noreferrer" lang={story.sourceHeadlineLang}>{story.sourceHeadline}</a>
                      {" — "}{story.publisher}, <time dateTime={story.sourcePublishedOn}>{formatEditionDate(story.sourcePublishedOn, locale)}</time>
                    </p>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <div className="inline-actions">
              <span className="btn btn-light btn-disabled" aria-disabled="true">{t.briefComing}</span>
            </div>
          )}
        </div>
      </section>

      <section className="shell content-section compact">
        <div className="feature-panel">
          <div className="kicker">{t.learningKicker}</div>
          <h2>{t.learningTitle}</h2>
          <p>{t.learningCopy}</p>
          <div className="inline-actions">
            <Link className="btn btn-secondary" href={localizedPath(locale, "/technology")}>{t.exploreTechnology}</Link>
          </div>
        </div>
      </section>

      <ContactCta title={t.ctaTitle} locale={locale}>{t.ctaCopy}</ContactCta>
    </div>
  );
}
