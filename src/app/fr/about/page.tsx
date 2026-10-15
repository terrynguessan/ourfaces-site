import type { Metadata } from "next";
import AboutPageContent from "@/components/pages/AboutPageContent";

export const metadata: Metadata = {
  title: "À propos",
  description:
    "Découvrez OurFaces Import & Export, LLC, sa vision, sa mission, ses valeurs et son approche pratique de la technologie et des opportunités commerciales.",
};

export default function FrenchAboutPage() {
  return <AboutPageContent locale="fr" />;
}
