import type { Metadata } from "next";
import TechnologyPageContent from "@/components/pages/TechnologyPageContent";

export const metadata: Metadata = {
  title: "Technology Solutions",
  description:
    "OurFaces explores practical software solutions for workflows, information, decision support, and responsible applied AI.",
};

export default function TechnologyPage() {
  return <TechnologyPageContent locale="en" />;
}
