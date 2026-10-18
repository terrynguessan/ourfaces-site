import type { Metadata } from "next";
import ContactPageContent from "@/components/pages/ContactPageContent";
import { pageAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Contact",
  description: "Contact OurFaces about technology, business opportunities, partnerships, insights, or general inquiries.",
  alternates: pageAlternates("en", "/contact"),
};

export default function ContactPage() {
  return <ContactPageContent locale="en" />;
}
