import type { Metadata } from "next";
import LegalPageContent from "@/components/pages/LegalPageContent";
import { pageAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Avis de non-responsabilité",
  description: "Avis de non-responsabilité du site OurFaces.",
  alternates: pageAlternates("fr", "/disclaimer"),
};

export default function FrenchDisclaimerPage() {
  return <LegalPageContent locale="fr" kind="disclaimer" />;
}
