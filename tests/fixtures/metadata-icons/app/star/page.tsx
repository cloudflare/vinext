import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return {
    title: "Star icon",
    icons: {
      icon: "/star.png",
      apple: "/star-apple.png",
    },
  };
}

export default function StarIconPage() {
  return <h1 id="metadata-icons-page">Star icon page</h1>;
}
