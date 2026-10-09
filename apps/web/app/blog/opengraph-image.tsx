import { renderBlogOgImage, OG_IMAGE_SIZE } from "./_og-image";

export const alt = "Vinext blog";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderBlogOgImage({
    title: "The Vinext blog",
    description: "Release notes, deep dives, and engineering updates from the Vinext team.",
    footer: "Next.js, reimplemented on Vite",
  });
}
