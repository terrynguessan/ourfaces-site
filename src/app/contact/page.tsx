import type { Metadata } from "next";
import ContactPageContent from "@/components/pages/ContactPageContent";

export const metadata: Metadata = {
  title: "Contact",
  description: "Contact OurFaces about technology, business opportunities, partnerships, insights, or general inquiries.",
};

export default function ContactPage() {
  return <ContactPageContent locale="en" />;
}
