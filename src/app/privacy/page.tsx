import type { Metadata } from "next";
import LegalPageContent from "@/components/pages/LegalPageContent";
import { pageAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Privacy Policy for the OurFaces website.",
  alternates: pageAlternates("en", "/privacy"),
};

export default function PrivacyPage() {
  return <LegalPageContent locale="en" kind="privacy" />;
}
