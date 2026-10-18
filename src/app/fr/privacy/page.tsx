import type { Metadata } from "next";
import LegalPageContent from "@/components/pages/LegalPageContent";
import { pageAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Politique de confidentialité",
  description: "Politique de confidentialité du site OurFaces.",
  alternates: pageAlternates("fr", "/privacy"),
};

export default function FrenchPrivacyPage() {
  return <LegalPageContent locale="fr" kind="privacy" />;
}
