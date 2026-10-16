import type { Metadata } from "next";
import LegalPageContent from "@/components/pages/LegalPageContent";

export const metadata: Metadata = {
  title: "Accessibility Statement",
  description: "Accessibility Statement for the OurFaces website.",
};

export default function AccessibilityPage() {
  return <LegalPageContent locale="en" kind="accessibility" />;
}
