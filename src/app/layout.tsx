import type { Metadata } from "next";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.ourfaces.net"),
  title: {
    default: "OurFaces Import & Export, LLC",
    template: "%s | OurFaces",
  },
  description:
    "OurFaces develops practical technology solutions, explores business opportunities, and shares useful insights on emerging technologies and modern development practices.",
  openGraph: {
    title: "OurFaces Import & Export, LLC",
    description:
      "Practical technology solutions, business opportunities, and useful insights.",
    url: "https://www.ourfaces.net/",
    siteName: "OurFaces",
    images: [{ url: "/assets/ourfaces-og.png" }],
    type: "website",
  },
  icons: {
    icon: "/assets/favicon-192.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Header />
        <main id="main-content" className="site-main" tabIndex={-1}>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
