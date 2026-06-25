import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return {
    title: "Heart icon",
    icons: {
      icon: "/heart.png",
      apple: "/heart-apple.png",
      shortcut: "/heart-shortcut.png",
      other: [
        { rel: "apple-touch-icon-precomposed", url: "/heart-precomposed.png" },
        { rel: "mask-icon", url: "/heart-mask.svg" },
      ],
    },
  };
}

export default function HeartIconPage() {
  return <h1 id="metadata-icons-page">Heart icon page</h1>;
}
