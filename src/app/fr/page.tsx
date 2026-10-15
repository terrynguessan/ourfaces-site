import type { Metadata } from "next";
import HomePageContent from "@/components/pages/HomePageContent";

export const metadata: Metadata = {
  description:
    "OurFaces développe des solutions technologiques pratiques, explore des opportunités commerciales et partage des analyses utiles sur les technologies émergentes et les pratiques modernes de développement.",
};

export default function FrenchHomePage() {
  return <HomePageContent locale="fr" />;
}
