import type { Metadata } from "next";
import InsightsPageContent from "@/components/pages/InsightsPageContent";
import { pageAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Insights",
  description:
    "Selected insights from OurFaces on emerging technology, development practices, tools, techniques, and applied AI.",
  alternates: pageAlternates("en", "/insights"),
};

export default function InsightsPage() {
  return <InsightsPageContent locale="en" />;
}
