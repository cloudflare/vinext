import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { s } from "../../_styles.js";

// Fake blog data
const posts: Record<string, { title: string; content: string }> = {
  "hello-world": {
    title: "Hello World",
    content: "Welcome to vinext + nitro. This is a blog post rendered as RSC.",
  },
  "dynamic-routes": {
    title: "Dynamic Routes",
    content:
      "This page demonstrates dynamic [slug] routing with generateStaticParams.",
  },
  "server-components": {
    title: "Server Components",
    content: "React Server Components work seamlessly with vinext and nitro.",
  },
};

// generateStaticParams — pre-generate known slugs
export function generateStaticParams() {
  return Object.keys(posts).map((slug) => ({ slug }));
}

// generateMetadata — dynamic metadata based on route params
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = posts[slug];
  if (!post) {
    return { title: "Post Not Found" };
  }
  return {
    title: post.title,
    description: post.content.slice(0, 120),
    openGraph: {
      title: post.title,
      description: post.content.slice(0, 120),
      type: "article",
    },
  };
}

export default async function BlogPost({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = posts[slug];

  // notFound() — triggers 404 for unknown slugs
  if (!post) {
    notFound();
  }

  return (
    <main style={s.page}>
      <article>
        <p data-testid="blog-slug" style={s.mono}>
          /blog/{slug}
        </p>
        <h1
          data-testid="blog-title"
          style={{ ...s.title, marginTop: "0.25rem" }}
        >
          {post.title}
        </h1>
        <p style={{ marginTop: "0.75rem", lineHeight: 1.7 }}>{post.content}</p>
      </article>
      <nav style={{ ...s.card, padding: "1rem 1.25rem" }}>
        <h3 style={{ ...s.label, marginBottom: "0.5rem" }}>Other posts</h3>
        <ul style={{ listStyle: "none", display: "flex", gap: "1rem" }}>
          {Object.entries(posts)
            .filter(([key]) => key !== slug)
            .map(([key, p]) => (
              <li key={key}>
                <Link href={`/blog/${key}`}>{p.title}</Link>
              </li>
            ))}
        </ul>
      </nav>
      <Link href="/">← Back to home</Link>
    </main>
  );
}
