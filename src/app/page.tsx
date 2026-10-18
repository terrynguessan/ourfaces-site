import type { Metadata } from "next";
import HomePageContent from "@/components/pages/HomePageContent";
import { pageAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  alternates: pageAlternates("en", "/"),
};

export default function HomePage() {
  return <HomePageContent locale="en" />;
}
