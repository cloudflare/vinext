import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return {
    title: "Star icon",
    icons: {
      icon: [
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
      apple: "/star-apple.png",
      shortcut: "/star-shortcut.png",
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
