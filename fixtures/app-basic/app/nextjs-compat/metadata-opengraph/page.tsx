import type { Metadata } from "next";

export const metadata: Metadata = {
  openGraph: {
    title: "My custom title",
    description: "My custom description",
    url: "https://example.com",
    siteName: "My custom site name",
    locale: "en-US",
    type: "website",
    images: [
      {
        url: "https://example.com/image.png",
        width: 800,
        height: 600,
        alt: "My custom alt",
      },
    ],
  },
};

export default function Page() {
  return <div id="opengraph">OpenGraph page</div>;
}
