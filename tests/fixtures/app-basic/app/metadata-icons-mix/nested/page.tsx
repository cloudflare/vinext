import type { Metadata } from "next";

export const metadata: Metadata = {
  icons: {
    shortcut: "/shortcut-icon-nested.png",
    apple: "/apple-icon-nested.png",
    other: {
      rel: "apple-touch-icon-precomposed-nested",
      url: "/apple-touch-icon-precomposed-nested.png",
    },
  },
};

export default function MetadataIconsMixNestedPage() {
  return <p>hello world</p>;
}
