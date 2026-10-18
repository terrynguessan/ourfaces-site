import type { Metadata } from "next";
import TechnologyPageContent from "@/components/pages/TechnologyPageContent";
import { pageAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Solutions technologiques",
  description:
    "OurFaces explore des solutions logicielles pratiques pour les flux de travail, l’information, l’aide à la décision et l’IA appliquée de manière responsable.",
  alternates: pageAlternates("fr", "/technology"),
};

export default function FrenchTechnologyPage() {
  return <TechnologyPageContent locale="fr" />;
}
