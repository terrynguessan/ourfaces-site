import type { Metadata } from "next";
import LegalPageContent from "@/components/pages/LegalPageContent";

export const metadata: Metadata = {
  title: "Disclaimer",
  description: "Website disclaimer for OurFaces Import & Export, LLC.",
};

export default function DisclaimerPage() {
  return <LegalPageContent locale="en" kind="disclaimer" />;
}
