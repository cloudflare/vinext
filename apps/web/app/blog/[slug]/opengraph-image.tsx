import { renderBlogOgImage, OG_IMAGE_SIZE } from "../_og-image";
import { formatPostDate, posts, postsBySlug } from "../_source";

export const alt = "Vinext blog post";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export function generateStaticParams() {
  return posts.map((post) => ({ slug: post.slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const post = postsBySlug.get((await params).slug);
  // vinext's metadata image routes turn notFound() into a 500, so return the 404 directly.
  if (!post) return new Response("Not Found", { status: 404 });

  return renderBlogOgImage({
    title: post.title,
    description: post.description,
    footer: `${formatPostDate(post.date)} · ${post.authors.map((author) => author.name).join(", ")}`,
  });
}
