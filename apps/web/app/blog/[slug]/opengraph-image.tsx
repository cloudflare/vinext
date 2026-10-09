import { notFound } from "next/navigation";
import { renderBlogOgImage, OG_IMAGE_SIZE } from "../_og-image";
import { formatPostDate, posts, postsBySlug } from "../_source";

export const alt = "vinext blog post";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export function generateStaticParams() {
  return posts.map((post) => ({ slug: post.slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const post = postsBySlug[(await params).slug];
  if (!post) notFound();

  return renderBlogOgImage({
    title: post.title,
    description: post.description,
    badge: post.version ? `v${post.version}` : undefined,
    footer: `${formatPostDate(post.date)} · ${post.authors.map((author) => author.name).join(", ")}`,
  });
}
