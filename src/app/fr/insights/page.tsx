import type { Metadata } from "next";
import InsightsPageContent from "@/components/pages/InsightsPageContent";
import { pageAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Perspectives",
  description:
    "Une sélection d’analyses d’OurFaces sur les technologies émergentes, les pratiques de développement, les outils, les techniques et l’IA appliquée.",
  alternates: pageAlternates("fr", "/insights"),
};

export default function FrenchInsightsPage() {
  return <InsightsPageContent locale="fr" />;
}
