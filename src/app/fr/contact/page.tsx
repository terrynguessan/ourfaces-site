import type { Metadata } from "next";
import ContactPageContent from "@/components/pages/ContactPageContent";
import { pageAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Contactez OurFaces au sujet de la technologie, des opportunités commerciales, des partenariats, des perspectives ou de toute demande générale.",
  alternates: pageAlternates("fr", "/contact"),
};

export default function FrenchContactPage() {
  return <ContactPageContent locale="fr" />;
}
