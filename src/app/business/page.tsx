import type { Metadata } from "next";
import BusinessPageContent from "@/components/pages/BusinessPageContent";

export const metadata: Metadata = {
  title: "Business",
  description:
    "OurFaces explores business relationships, partnerships, market opportunities, and long-term opportunities across markets.",
};

export default function BusinessPage() {
  return <BusinessPageContent locale="en" />;
}
