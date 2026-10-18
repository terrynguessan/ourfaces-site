import type { Metadata } from "next";
import BusinessPageContent from "@/components/pages/BusinessPageContent";
import { pageAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Business",
  description:
    "OurFaces explores business relationships, partnerships, market opportunities, and long-term opportunities across markets.",
  alternates: pageAlternates("en", "/business"),
};

export default function BusinessPage() {
  return <BusinessPageContent locale="en" />;
}
