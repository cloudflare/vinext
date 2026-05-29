import type { Metadata } from "next";

export const metadata: Metadata = {
  icons: {
    shortcut: "/shortcut-icon.png",
    apple: "/apple-icon.png",
    other: {
      rel: "apple-touch-icon-precomposed",
      url: "/apple-touch-icon-precomposed.png",
    },
  },
};

export default function MetadataIconsMixPage() {
  return <p>hello world</p>;
}
