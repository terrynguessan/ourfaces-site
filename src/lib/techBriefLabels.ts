import type { Locale } from "@/lib/i18n";
import type { TechBriefCategory } from "@/lib/techBrief";

/** Display names for Tech Brief story categories, shared by every page that
 *  shows published stories so the two languages cannot drift apart. */
export const techBriefCategoryLabels: Record<
  Locale,
  Record<TechBriefCategory, string>
> = {
  en: {
    "emerging-technology": "Emerging Technology",
    "development-practices": "Development Practices",
    "tools-techniques": "Tools & Techniques",
    "applied-ai": "Applied AI",
  },
  fr: {
    "emerging-technology": "Technologies émergentes",
    "development-practices": "Pratiques de développement",
    "tools-techniques": "Outils et techniques",
    "applied-ai": "IA appliquée",
  },
};
