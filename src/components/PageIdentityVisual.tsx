type VisualVariant = "technology" | "business" | "insights" | "about" | "contact";

const visualSources: Record<VisualVariant, { src: string; alt: string }> = {
  technology: {
    src: "/assets/page-visuals/technology.png",
    alt: "Laptop displaying software code in a bright workspace",
  },
  business: {
    src: "/assets/page-visuals/business.png",
    alt: "Business professionals shaking hands in a bright meeting room",
  },
  insights: {
    src: "/assets/page-visuals/insights.png",
    alt: "Professional reviewing information with data visualizations in a modern workspace",
  },
  about: {
    src: "/assets/page-visuals/about.png",
    alt: "Team collaborating around a table in a bright creative workspace",
  },
  contact: {
    src: "/assets/page-visuals/contact.png",
    alt: "Professional speaking on the phone while working at a laptop",
  },
};

export default function PageIdentityVisual({ variant }: { variant: VisualVariant }) {
  const visual = visualSources[variant];

  return (
    <div className={`page-identity-visual identity-${variant}`}>
      <img className="page-identity-photo" src={visual.src} alt={visual.alt} />
    </div>
  );
}
