import type { Metadata } from "next";
import TechnologyPageContent from "@/components/pages/TechnologyPageContent";
import { pageAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Technology Solutions",
  description:
    "OurFaces explores practical software solutions for workflows, information, decision support, and responsible applied AI.",
  alternates: pageAlternates("en", "/technology"),
};

export default function TechnologyPage() {
  return <TechnologyPageContent locale="en" />;
}
