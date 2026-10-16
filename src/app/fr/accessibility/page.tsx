import type { Metadata } from "next";
import LegalPageContent from "@/components/pages/LegalPageContent";

export const metadata: Metadata = {
  title: "Déclaration d’accessibilité",
  description: "Déclaration d’accessibilité du site OurFaces.",
};

export default function FrenchAccessibilityPage() {
  return <LegalPageContent locale="fr" kind="accessibility" />;
}
