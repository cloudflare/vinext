import { notFound } from "next/navigation";

const posts: Record<string, { public: boolean; text: string }> = {
  "public-post": { public: true, text: "PUBLIC" },
  "public post": { public: true, text: "PUBLIC ENCODED" },
  "public%20post": { public: true, text: "PUBLIC ESCAPED" },
  "public%2Fpost": { public: true, text: "PUBLIC ESCAPED SLASH" },
  "unlisted-draft": { public: false, text: "UNLISTED_METADATA" },
};

export const dynamicParams = false;

export function generateStaticParams() {
  return [
    { slug: "public-post" },
    { slug: "public post" },
    { slug: "public%20post" },
    { slug: "public%2Fpost" },
  ];
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = posts[slug];

  if (!post?.public) notFound();

  return <main>{post.text}</main>;
}
