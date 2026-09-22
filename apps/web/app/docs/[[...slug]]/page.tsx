import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { docPages, docsNavigation } from "../_source";
import { PackageManagerProvider } from "../_package-manager";

type Props = {
  params: Promise<{ slug?: string[] }>;
};

export const revalidate = 300;

export function generateStaticParams() {
  return Object.keys(docPages).map((slug) => ({ slug: slug ? slug.split("/") : [] }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const key = (await params).slug?.join("/") ?? "";
  const page = docPages[key];

  if (!page) return {};

  return {
    title: `${page.title} | vinext`,
    description: page.description,
    keywords: page.keywords,
    alternates: { canonical: key ? `/docs/${key}` : "/docs" },
    openGraph: {
      type: "article",
      siteName: "vinext",
      title: page.title,
      description: page.description,
      url: key ? `/docs/${key}` : "/docs",
    },
    twitter: {
      card: "summary",
      title: page.title,
      description: page.description,
    },
    robots: { index: true, follow: true },
  };
}

export default async function DocsPage({ params }: Props) {
  const key = (await params).slug?.join("/") ?? "";
  const page = docPages[key];

  if (!page) notFound();

  const currentPath = key ? `/docs/${key}` : "/docs";
  const Content = page.content;
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: page.title,
    description: page.description,
    url: `https://vinext.dev${currentPath}`,
    mainEntityOfPage: `https://vinext.dev${currentPath}`,
    isPartOf: {
      "@type": "WebSite",
      name: "vinext",
      url: "https://vinext.dev",
    },
    author: {
      "@type": "Organization",
      name: "Cloudflare",
      url: "https://www.cloudflare.com",
    },
  };

  const navigation = (
    <nav aria-label="Documentation">
      {docsNavigation.map((section) => (
        <div key={section.title} className="mb-7">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
            {section.title}
          </h2>
          <ul className="space-y-1">
            {section.items.map((item) => {
              const external = item.href.startsWith("http");
              const active = item.href === currentPath;
              return (
                <li key={item.href}>
                  {external ? (
                    <a
                      href={item.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-md px-3 py-2 text-sm text-kumo-subtle hover:bg-kumo-base hover:text-kumo-default"
                    >
                      {item.title}
                    </a>
                  ) : (
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`block rounded-md px-3 py-2 text-sm ${
                        active
                          ? "bg-kumo-base font-medium text-kumo-default"
                          : "text-kumo-subtle hover:bg-kumo-base hover:text-kumo-default"
                      }`}
                    >
                      {item.title}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <PackageManagerProvider>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <div className="mx-auto flex w-full max-w-6xl flex-1 px-6">
        <aside className="hidden w-64 shrink-0 border-r border-kumo-hairline py-10 pr-8 lg:block">
          <div className="sticky top-8">{navigation}</div>
        </aside>

        <div className="min-w-0 flex-1 py-8 lg:px-12 lg:py-14">
          <details className="mb-8 rounded-lg border border-kumo-line bg-kumo-base p-4 lg:hidden">
            <summary className="cursor-pointer font-medium text-kumo-default">
              Documentation menu
            </summary>
            <div className="mt-5 border-t border-kumo-line pt-5">{navigation}</div>
          </details>

          <article className="mx-auto max-w-3xl">
            <header className="mb-10 border-b border-kumo-hairline pb-8">
              <p className="mb-3 text-sm font-medium text-kumo-subtle">Documentation</p>
              <h1 className="text-4xl font-semibold tracking-tight text-kumo-default sm:text-5xl">
                {page.title}
              </h1>
              <p className="mt-4 text-lg leading-8 text-kumo-subtle">{page.description}</p>
            </header>
            <div className="docs-copy">
              <Content />
            </div>
          </article>
        </div>
      </div>
    </PackageManagerProvider>
  );
}
