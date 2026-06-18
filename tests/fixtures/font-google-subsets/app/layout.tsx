import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

// `geistSans` requests only the latin subset — Next.js parity requires that
// only latin font files are preloaded even though the Google Fonts CSS
// response contains @font-face rules for every available subset.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// `geistMono` opts out of preloading entirely — Next.js emits no
// <link rel="preload"> for it at all.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  preload: false,
});

export const metadata: Metadata = {
  title: "Font Google Subsets Test",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
