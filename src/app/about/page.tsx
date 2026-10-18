import type { Metadata } from "next";
import AboutPageContent from "@/components/pages/AboutPageContent";
import { pageAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "About",
  description:
    "Learn about OurFaces Import & Export, LLC, its vision, mission, values, and practical approach to technology and business opportunities.",
  alternates: pageAlternates("en", "/about"),
};

export default function AboutPage() {
  return <AboutPageContent locale="en" />;
}
