import type { Metadata } from "next";
import ContactPageContent from "@/components/pages/ContactPageContent";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Contactez OurFaces au sujet de la technologie, des opportunités commerciales, des partenariats, des perspectives ou de toute demande générale.",
};

export default function FrenchContactPage() {
  return <ContactPageContent locale="fr" />;
}
