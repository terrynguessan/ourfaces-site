import type { Metadata } from "next";
import InsightsPageContent from "@/components/pages/InsightsPageContent";

export const metadata: Metadata = {
  title: "Insights",
  description:
    "Selected insights from OurFaces on emerging technology, development practices, tools, techniques, and applied AI.",
};

export default function InsightsPage() {
  return <InsightsPageContent locale="en" />;
}
