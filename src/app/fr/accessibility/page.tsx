import type { Metadata } from "next";
import LegalPageContent from "@/components/pages/LegalPageContent";
import { pageAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Déclaration d’accessibilité",
  description: "Déclaration d’accessibilité du site OurFaces.",
  alternates: pageAlternates("fr", "/accessibility"),
};

export default function FrenchAccessibilityPage() {
  return <LegalPageContent locale="fr" kind="accessibility" />;
}
