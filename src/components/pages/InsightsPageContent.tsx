import type { Locale } from "@/lib/i18n";
import type { TechBriefStory } from "@/lib/techBrief";
import { formatEditionDate, getLatestEdition } from "@/lib/techBrief";
import { getPreviousEditions } from "@/lib/techBriefArchive";
import { techBriefCategoryLabels } from "@/lib/techBriefLabels";

const copy = {
  en: {
    title: "Insights",
    publication: "OurFaces Tech Brief",
    latestEdition: "Latest edition",
    noEdition: "No Tech Brief edition is available at the moment.",
    moreStories: "More stories in this edition",
    whyItMatters: "Why it matters",
    source: "Source:",
    previousEditions: "Previous Editions",
    articles: "articles",
  },
  fr: {
    title: "Perspectives",
    publication: "OurFaces Tech Brief",
    latestEdition: "Dernière édition",
    noEdition: "Aucune édition du Tech Brief n’est disponible pour le moment.",
    moreStories: "Autres articles de cette édition",
    whyItMatters: "Pourquoi c’est important",
    // A non-breaking space keeps the colon from wrapping onto its own line.
    source: "Source :",
    previousEditions: "Éditions précédentes",
    articles: "articles",
  },
} as const;

type StoryProps = { story: TechBriefStory; locale: Locale };

// Articles link only to their verified original source: the site has no
// OurFaces-hosted article pages, so headlines themselves are not links.
function StorySource({ story, locale }: StoryProps) {
  return (
    <p className="brief-source">
      {copy[locale].source}{" "}
      <a href={story.url} rel="noopener noreferrer" lang={story.sourceHeadlineLang}>{story.sourceHeadline}</a>
      {" — "}{story.publisher}, <time dateTime={story.sourcePublishedOn}>{formatEditionDate(story.sourcePublishedOn, locale)}</time>
    </p>
  );
}

function Story({ story, locale, lead = false }: StoryProps & { lead?: boolean }) {
  const t = copy[locale];
  const text = story[locale];
  const headingId = `brief-story-${story.id}`;

  return (
    <article className={lead ? "brief-story brief-story-lead" : "brief-story"} aria-labelledby={headingId}>
      <div className="brief-story-main">
        <p className="brief-category">{techBriefCategoryLabels[locale][story.category]}</p>
        <h3 id={headingId}>{text.headline}</h3>
        <p className="brief-summary">{text.summary}</p>
      </div>
      <div className="brief-story-notes">
        <div className="brief-why">
          <p className="brief-why-label">{t.whyItMatters}</p>
          <p>{text.whyItMatters}</p>
        </div>
        <StorySource story={story} locale={locale} />
      </div>
    </article>
  );
}

export default function InsightsPageContent({ locale }: { locale: Locale }) {
  const t = copy[locale];
  const edition = getLatestEdition();
  const previousEditions = getPreviousEditions(edition);
  const [leadStory, ...moreStories] = edition?.stories ?? [];

  return (
    <div lang={locale}>
      <section className="shell insights-masthead">
        <h1>{t.title}</h1>
        <p className="insights-publication">{t.publication}</p>
      </section>

      {edition ? (
        <section className="shell insights-edition" aria-labelledby="latest-edition-title" data-edition={edition.edition}>
          <h2 id="latest-edition-title" className="insights-edition-title">
            {t.latestEdition} · <time dateTime={edition.publishedOn}>{formatEditionDate(edition.publishedOn, locale)}</time>
          </h2>
          <Story story={leadStory} locale={locale} lead />
          {moreStories.length > 0 && (
            <ol className={moreStories.length % 3 === 0 ? "brief-cards three-up" : "brief-cards"} aria-label={t.moreStories}>
              {moreStories.map((story) => (
                <li key={story.id}>
                  <Story story={story} locale={locale} />
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : (
        <section className="shell insights-edition">
          <p className="insights-empty">{t.noEdition}</p>
        </section>
      )}

      {previousEditions.length > 0 && (
        <section className="shell insights-archive" aria-labelledby="previous-editions-title">
          <h2 id="previous-editions-title">{t.previousEditions}</h2>
          <ol className="brief-archive">
            {previousEditions.map((archived) => (
              <li key={archived.edition} data-edition={archived.edition}>
                <details>
                  <summary>
                    <time dateTime={archived.publishedOn}>{formatEditionDate(archived.publishedOn, locale)}</time>{" "}
                    <span className="brief-archive-count">{archived.stories.length} {t.articles}</span>
                  </summary>
                  <ol className="brief-archive-stories">
                    {archived.stories.map((story) => (
                      <li key={story.id}>
                        <p className="brief-archive-headline">{story[locale].headline}</p>
                        <StorySource story={story} locale={locale} />
                      </li>
                    ))}
                  </ol>
                </details>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
