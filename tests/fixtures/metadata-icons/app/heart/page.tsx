import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return {
    title: "Heart icon",
    icons: {
      icon: "/heart.png",
      apple: "/heart-apple.png",
    },
  };
}

export default function HeartIconPage() {
  return <h1 id="metadata-icons-page">Heart icon page</h1>;
}
