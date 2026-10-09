import { Badge } from "@cloudflare/kumo/components/badge";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatPostDate, postPath, posts, postsBySlug, SITE_URL } from "../_source";

type Props = {
  params: Promise<{ slug: string }>;
};

export const revalidate = 300;
export const dynamicParams = false;

export function generateStaticParams() {
  return posts.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = postsBySlug[(await params).slug];
  if (!post) return {};

  const path = postPath(post);
  return {
    title: `${post.title} | Vinext blog`,
    description: post.description,
    keywords: post.tags,
    authors: post.authors,
    alternates: {
      canonical: path,
      types: { "application/rss+xml": "/blog/feed.xml" },
    },
    openGraph: {
      type: "article",
      siteName: "Vinext",
      locale: "en_US",
      title: post.title,
      description: post.description,
      url: path,
      publishedTime: post.date,
      modifiedTime: post.updated ?? post.date,
      authors: post.authors.map((author) => author.url ?? author.name),
      tags: post.tags,
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.description,
    },
    robots: post.draft ? { index: false, follow: false } : { index: true, follow: true },
  };
}

export default async function BlogPostPage({ params }: Props) {
  const post = postsBySlug[(await params).slug];
  if (!post) notFound();

  const url = `${SITE_URL}${postPath(post)}`;
  const Content = post.content;
  const morePosts = posts.filter((other) => other.slug !== post.slug).slice(0, 3);
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BlogPosting",
        headline: post.title,
        description: post.description,
        url,
        mainEntityOfPage: url,
        image: `${url}/opengraph-image`,
        datePublished: post.date,
        dateModified: post.updated ?? post.date,
        keywords: post.tags,
        inLanguage: "en-US",
        author: post.authors.map((author) => ({
          "@type": "Person",
          name: author.name,
          url: author.url,
        })),
        publisher: {
          "@type": "Organization",
          name: "Cloudflare",
          url: "https://www.cloudflare.com",
        },
        isPartOf: {
          "@type": "Blog",
          name: "Vinext blog",
          url: `${SITE_URL}/blog`,
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Vinext", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE_URL}/blog` },
          { "@type": "ListItem", position: 3, name: post.title, item: url },
        ],
      },
    ],
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10 lg:py-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <nav aria-label="Breadcrumb" className="mb-8">
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 text-sm text-kumo-subtle hover:text-kumo-default"
        >
          <ArrowLeftIcon aria-hidden />
          All posts
        </Link>
      </nav>

      <article>
        <header className="mb-10 border-b border-kumo-hairline pb-8">
          {post.draft ? (
            <div className="mb-4">
              <Badge variant="outline">Draft</Badge>
            </div>
          ) : null}
          <h1 className="text-4xl font-semibold tracking-tight text-kumo-default sm:text-5xl">
            {post.title}
          </h1>
          <p className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-kumo-subtle">
            <span>
              {post.authors.map((author, index) => (
                <span key={author.name}>
                  {index > 0 ? ", " : null}
                  {author.url ? (
                    <a
                      href={author.url}
                      rel="author"
                      className="font-medium text-kumo-default hover:underline"
                    >
                      {author.name}
                    </a>
                  ) : (
                    <span className="font-medium text-kumo-default">{author.name}</span>
                  )}
                </span>
              ))}
            </span>
            <span aria-hidden>·</span>
            <time dateTime={post.date}>{formatPostDate(post.date)}</time>
            <span aria-hidden>·</span>
            <span>{post.readingMinutes} min read</span>
          </p>
        </header>

        <div className="docs-copy">
          <Content />
        </div>
      </article>

      {morePosts.length > 0 ? (
        <aside className="mt-16 border-t border-kumo-hairline pt-10">
          <h2 className="mb-6 text-sm font-semibold uppercase tracking-wider text-kumo-subtle">
            More from the blog
          </h2>
          <ul className="space-y-6">
            {morePosts.map((other) => (
              <li key={other.slug}>
                <Link href={postPath(other)} className="group block">
                  <p className="text-lg font-semibold text-kumo-default group-hover:underline">
                    {other.title}
                  </p>
                  <p className="mt-1 text-sm text-kumo-subtle">
                    <time dateTime={other.date}>{formatPostDate(other.date)}</time>
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </aside>
      ) : null}
    </div>
  );
}
