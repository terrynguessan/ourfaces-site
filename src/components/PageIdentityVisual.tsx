import type { Locale } from "@/lib/i18n";

type VisualVariant = "technology" | "business" | "insights" | "about" | "contact";

const visualSources: Record<VisualVariant, { src: string; en: string; fr: string }> = {
  technology: {
    src: "/assets/page-visuals/technology.png",
    en: "Laptop displaying software code in a bright workspace",
    fr: "Ordinateur portable affichant du code dans un espace de travail lumineux",
  },
  business: {
    src: "/assets/page-visuals/business.png",
    en: "Business professionals shaking hands in a bright meeting room",
    fr: "Professionnels se serrant la main dans une salle de réunion lumineuse",
  },
  insights: {
    src: "/assets/page-visuals/insights.png",
    en: "Professional reviewing information with data visualizations in a modern workspace",
    fr: "Professionnelle analysant des informations et des visualisations de données dans un espace moderne",
  },
  about: {
    src: "/assets/page-visuals/about.png",
    en: "Team collaborating around a table in a bright creative workspace",
    fr: "Équipe collaborant autour d’une table dans un espace de travail créatif et lumineux",
  },
  contact: {
    src: "/assets/page-visuals/contact.png",
    en: "Professional speaking on the phone while working at a laptop",
    fr: "Professionnelle au téléphone devant son ordinateur portable",
  },
};

export default function PageIdentityVisual({
  variant,
  locale = "en",
}: {
  variant: VisualVariant;
  locale?: Locale;
}) {
  const visual = visualSources[variant];

  return (
    <div className={`page-identity-visual identity-${variant}`}>
      <img className="page-identity-photo" src={visual.src} alt={locale === "fr" ? visual.fr : visual.en} />
    </div>
  );
}
