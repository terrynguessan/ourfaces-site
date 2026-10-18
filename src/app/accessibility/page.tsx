import type { Metadata } from "next";
import LegalPageContent from "@/components/pages/LegalPageContent";
import { pageAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Accessibility Statement",
  description: "Accessibility Statement for the OurFaces website.",
  alternates: pageAlternates("en", "/accessibility"),
};

export default function AccessibilityPage() {
  return <LegalPageContent locale="en" kind="accessibility" />;
}
