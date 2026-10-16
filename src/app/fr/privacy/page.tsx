import type { Metadata } from "next";
import LegalPageContent from "@/components/pages/LegalPageContent";

export const metadata: Metadata = {
  title: "Politique de confidentialité",
  description: "Politique de confidentialité du site OurFaces.",
};

export default function FrenchPrivacyPage() {
  return <LegalPageContent locale="fr" kind="privacy" />;
}
