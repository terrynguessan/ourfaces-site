import type { Locale } from "@/lib/i18n";

export default function EarthVisual({ locale = "en" }: { locale?: Locale }) {
  const text = locale === "fr"
    ? {
        technologyTitle: "Solutions technologiques",
        technologyCopy: "Une technologie pratique pour des besoins concrets.",
        businessTitle: "Opportunités commerciales",
        businessCopy: "Relier les idées, les capacités et les opportunités.",
      }
    : {
        technologyTitle: "Technology solutions",
        technologyCopy: "Practical technology for real-world needs.",
        businessTitle: "Business opportunities",
        businessCopy: "Connecting ideas, capabilities, and opportunities.",
      };

  return (
    <div className="earth-stage" aria-hidden="true">
      <div className="earth-glow" />
      <div className="earth-sphere">
        <div className="earth-texture" />
        <div className="earth-shade" />
        <div className="earth-atmosphere" />
      </div>
      <div className="float-card float-card-tech">
        <strong><span className="dot" />{text.technologyTitle}</strong>
        <span>{text.technologyCopy}</span>
      </div>
      <div className="float-card float-card-business">
        <strong><span className="dot" />{text.businessTitle}</strong>
        <span>{text.businessCopy}</span>
      </div>
    </div>
  );
}
