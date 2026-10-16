import type { Metadata } from "next";
import LegalPageContent from "@/components/pages/LegalPageContent";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Privacy Policy for the OurFaces website.",
};

export default function PrivacyPage() {
  return <LegalPageContent locale="en" kind="privacy" />;
}
