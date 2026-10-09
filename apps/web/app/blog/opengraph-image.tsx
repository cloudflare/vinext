import { renderBlogOgImage, OG_IMAGE_SIZE } from "./_og-image";

export const alt = "vinext blog";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderBlogOgImage({
    title: "The vinext blog",
    description: "Release notes, deep dives, and engineering updates from the vinext team.",
    footer: "Next.js, reimplemented on Vite",
  });
}
