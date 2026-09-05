import type { Metadata } from "next";
import readme from "virtual:vinext-readme";
import { LinkButton } from "@cloudflare/kumo/components/button";
import { Text } from "@cloudflare/kumo/components/text";
import { GithubLogoIcon } from "@phosphor-icons/react/dist/ssr";
import { StructuredData } from "@/app/_components/structured-data";
import { breadcrumbGraph } from "@/app/_lib/structured-data";

// Bare title: the root layout's `%s — vinext` template supplies the suffix.
const title = "Documentation";
const brandedTitle = `${title} — vinext`;
const description =
  "The full vinext documentation: quick start, CLI reference, Next.js API coverage, deployment targets, caching, and known gaps.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: "/readme",
  },
  openGraph: {
    type: "article",
    locale: "en_US",
    siteName: "vinext",
    title: brandedTitle,
    description,
    url: "/readme",
  },
  twitter: {
    title: brandedTitle,
    description,
  },
};

/**
 * The README rendered on the canonical domain.
 *
 * Note that github.com hosts the same prose and carries more authority, so
 * search engines are likely to treat this copy as the derivative one for as
 * long as both are full length. No `rel=canonical` to github.com is set: that
 * would explicitly concede the ranking. The intended end state is the inverse
 * of today — the README shrinks to an overview that links here for detail.
 */
export const revalidate = 300;

/** Only h2/h3 make the contents list; deeper levels make it unreadable. */
const TOC_MAX_DEPTH = 3;

export default function ReadmePage() {
  const toc = readme.headings.filter(
    (heading) => heading.depth > 1 && heading.depth <= TOC_MAX_DEPTH,
  );

  return (
    <>
      <StructuredData graph={breadcrumbGraph(title, "/readme")} />

      <section className="mx-auto w-full max-w-6xl px-6 pt-16 pb-8">
        <h1 className="text-4xl font-semibold tracking-tight text-kumo-default sm:text-5xl">
          vinext documentation
        </h1>
        <p className="mt-4 max-w-2xl text-kumo-subtle">{description}</p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <LinkButton
            variant="secondary"
            size="sm"
            icon={<GithubLogoIcon />}
            href={readme.sourceUrl}
            external
          >
            Edit this page on GitHub
          </LinkButton>
        </div>
      </section>

      <div className="mx-auto grid w-full max-w-6xl gap-12 px-6 pb-24 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <article
          className="vinext-readme min-w-0"
          // Built at build time by apps/web/vite-plugins/readme-html.ts from the
          // repo README. The input is first-party and the renderer escapes all
          // text, so the only HTML that survives is what that renderer emits.
          dangerouslySetInnerHTML={{ __html: readme.html }}
        />

        <nav aria-label="On this page" className="hidden lg:block">
          <div className="sticky top-8 flex flex-col gap-2">
            <Text variant="secondary" size="sm">
              On this page
            </Text>
            <ul className="flex flex-col gap-1.5 border-l border-kumo-hairline">
              {toc.map(({ slug, text, depth }) => (
                <li key={slug}>
                  <a
                    href={`#${slug}`}
                    className={`block border-l border-transparent pl-3 text-sm text-kumo-subtle transition-colors hover:border-kumo-hairline hover:text-kumo-default ${
                      depth === 3 ? "pl-6" : ""
                    }`}
                  >
                    {text}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>
      </div>
    </>
  );
}
