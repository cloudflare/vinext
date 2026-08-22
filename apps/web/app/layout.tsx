import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "./_components/site-header";
import { SiteFooter } from "./_components/site-footer";
import { StructuredData } from "./_components/structured-data";
import { SITE_DESCRIPTION, siteGraph } from "./_lib/structured-data";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://vinext.dev"),
  // `template` brands every child route, so a new page cannot silently inherit
  // the home page title. Pages pass a bare title; use `title.absolute` to opt out.
  title: {
    default: "vinext — The Next.js API surface, reimplemented on Vite",
    template: "%s — vinext",
  },
  description: SITE_DESCRIPTION,
  applicationName: "vinext",
  creator: "Cloudflare",
  publisher: "Cloudflare",
  // Without an explicit googleBot block, snippets and image previews sit at
  // Google's conservative defaults.
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-snippet": -1,
      "max-image-preview": "large",
      "max-video-preview": -1,
    },
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "vinext",
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-kumo-canvas text-kumo-default">
        <StructuredData graph={siteGraph} />
        <SiteHeader />
        <main className="flex flex-1 flex-col">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
