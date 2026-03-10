import type { Metadata } from "next";

export const metadata: Metadata = {
  openGraph: {
    title: "Single image test",
    description: "Testing single image object",
    url: "https://example.com",
    type: "website",
    images: {
      url: "https://example.com/single.png",
      width: 1200,
      height: 630,
      alt: "Single image alt",
    },
  },
  twitter: {
    card: "summary_large_image",
    images: {
      url: "https://example.com/twitter-single.png",
      alt: "Twitter single image",
    },
  },
};

export default function Page() {
  return <div id="opengraph-single-image">OpenGraph single image page</div>;
}
