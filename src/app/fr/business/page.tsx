import type { Metadata } from "next";
import BusinessPageContent from "@/components/pages/BusinessPageContent";

export const metadata: Metadata = {
  title: "Affaires",
  description:
    "OurFaces explore des relations d’affaires, des partenariats, des opportunités de marché et des possibilités à long terme sur différents marchés.",
};

export default function FrenchBusinessPage() {
  return <BusinessPageContent locale="fr" />;
}
