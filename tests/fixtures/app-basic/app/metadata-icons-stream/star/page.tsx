import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return {
    title: "Star icon",
    icons: {
      icon: [
        { url: "/star-shared.png" },
        { url: "/star-shared.png", type: "image/png" },
        { url: "/star-duplicate.png", sizes: "24x24", type: "image/png" },
        { url: "/star-duplicate.png", sizes: "24x24", type: "image/png" },
        {
          url: "/star.png",
          sizes: "16x16",
          type: "image/png",
          media: "(prefers-color-scheme: light)",
        },
        {
          url: "/star.png",
          sizes: "32x32",
          type: "image/png",
          media: "(prefers-color-scheme: dark)",
        },
        { url: "/star.png", sizes: "any", type: "image/svg+xml" },
      ],
      apple: {
        url: "/star-apple.png",
        media: "screen",
        color: "#123456",
        fetchPriority: "low",
      },
      shortcut: {
        url: "/star-shortcut.png",
        rel: "shortcut icon",
        sizes: "48x48",
        type: "image/png",
        media: "screen",
        color: "#654321",
        fetchPriority: "high",
      },
      other: [
        { rel: "apple-touch-icon-precomposed", url: "/star-precomposed.png" },
        { rel: "mask-icon", url: "/star-mask.svg" },
      ],
    },
  };
}

export default function StarIconPage() {
  return <h1 id="metadata-icons-page">Star icon page</h1>;
}
