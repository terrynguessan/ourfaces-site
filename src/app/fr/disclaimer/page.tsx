import type { Metadata } from "next";
import LegalPageContent from "@/components/pages/LegalPageContent";

export const metadata: Metadata = {
  title: "Avis de non-responsabilité",
  description: "Avis de non-responsabilité du site OurFaces.",
};

export default function FrenchDisclaimerPage() {
  return <LegalPageContent locale="fr" kind="disclaimer" />;
}
