import type { Metadata } from "next";
import LegalPageContent from "@/components/pages/LegalPageContent";
import { pageAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Disclaimer",
  description: "Website disclaimer for OurFaces Import & Export, LLC.",
  alternates: pageAlternates("en", "/disclaimer"),
};

export default function DisclaimerPage() {
  return <LegalPageContent locale="en" kind="disclaimer" />;
}
