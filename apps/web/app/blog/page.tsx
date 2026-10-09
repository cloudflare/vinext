import { Badge } from "@cloudflare/kumo/components/badge";
import { RssIcon } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import Link from "next/link";
import { formatPostDate, postPath, posts, SITE_URL } from "./_source";

const title = "vinext blog";
const description =
  "Release notes, deep dives, and engineering updates from the team building vinext, the Next.js API surface reimplemented on Vite.";

export const metadata: Metadata = {
  title: "Blog | vinext",
  description,
  keywords: ["vinext blog", "vinext releases", "Next.js on Vite", "Next.js on Cloudflare Workers"],
  alternates: {
    canonical: "/blog",
    types: { "application/rss+xml": "/blog/feed.xml" },
  },
  openGraph: {
    type: "website",
    siteName: "vinext",
    locale: "en_US",
    title,
    description,
    url: "/blog",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
};

export const revalidate = 300;

export default function BlogIndexPage() {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: title,
    description,
    url: `${SITE_URL}/blog`,
    publisher: {
      "@type": "Organization",
      name: "Cloudflare",
      url: "https://www.cloudflare.com",
    },
    blogPost: posts.map((post) => ({
      "@type": "BlogPosting",
      headline: post.title,
      description: post.description,
      url: `${SITE_URL}${postPath(post)}`,
      datePublished: post.date,
      dateModified: post.updated ?? post.date,
      author: post.authors.map((author) => ({
        "@type": "Person",
        name: author.name,
        url: author.url,
      })),
    })),
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10 lg:py-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <header className="mb-12 border-b border-kumo-hairline pb-8">
        <div className="flex items-start justify-between gap-6">
          <h1 className="text-4xl font-semibold tracking-tight text-kumo-default sm:text-5xl">
            Blog
          </h1>
          <a
            href="/blog/feed.xml"
            className="mt-2 inline-flex items-center gap-1.5 text-sm text-kumo-subtle hover:text-kumo-default"
          >
            <RssIcon aria-hidden />
            RSS
          </a>
        </div>
        <p className="mt-4 text-lg leading-8 text-kumo-subtle">{description}</p>
      </header>

      {posts.length === 0 ? (
        <p className="text-kumo-subtle">No posts yet.</p>
      ) : (
        <ol className="space-y-12">
          {posts.map((post) => (
            <li key={post.slug}>
              <article>
                <p className="flex flex-wrap items-center gap-2 text-sm text-kumo-subtle">
                  <time dateTime={post.date}>{formatPostDate(post.date)}</time>
                  {post.version ? <Badge variant="primary">v{post.version}</Badge> : null}
                  {post.draft ? <Badge variant="outline">Draft</Badge> : null}
                </p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight text-kumo-default">
                  <Link href={postPath(post)} className="hover:underline">
                    {post.title}
                  </Link>
                </h2>
                <p className="mt-3 leading-7 text-kumo-subtle">{post.description}</p>
                <Link
                  href={postPath(post)}
                  className="mt-4 inline-block text-sm font-medium text-kumo-default underline decoration-kumo-line underline-offset-4 hover:decoration-kumo-contrast"
                  aria-label={`Read “${post.title}”`}
                >
                  Read post · {post.readingMinutes} min
                </Link>
              </article>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
