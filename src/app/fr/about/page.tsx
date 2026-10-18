import type { Metadata } from "next";
import AboutPageContent from "@/components/pages/AboutPageContent";
import { pageAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "À propos",
  description:
    "Découvrez OurFaces Import & Export, LLC, sa vision, sa mission, ses valeurs et son approche pratique de la technologie et des opportunités commerciales.",
  alternates: pageAlternates("fr", "/about"),
};

export default function FrenchAboutPage() {
  return <AboutPageContent locale="fr" />;
}
