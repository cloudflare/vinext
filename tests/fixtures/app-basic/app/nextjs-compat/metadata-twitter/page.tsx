import type { Metadata } from "next";

export const metadata: Metadata = {
  twitter: {
    card: "summary_large_image",
    title: "Twitter Title",
    description: "Twitter Description",
    siteId: "siteId",
    creator: "creator",
    creatorId: "creatorId",
    images: ["https://twitter.com/image.png"],
  },
};

export default function Page() {
  return <div id="twitter">Twitter page</div>;
}
