import type { Metadata } from "next";
import Link from "next/link";
import { LinkButton } from "@cloudflare/kumo/components/button";
import { Text } from "@cloudflare/kumo/components/text";

/**
 * Without this route vinext falls back to a built-in 404 document that emits a
 * second <title> and brands every missing URL as the home page. `title.absolute`
 * opts out of the root layout's `%s — vinext` template.
 *
 * `robots` must be restated here. Metadata keys are replaced rather than merged
 * down the tree, so without it this page inherits the root layout's
 * `index, follow` and contradicts the `noindex` vinext emits for 404s.
 */
export const metadata: Metadata = {
  title: { absolute: "Page not found — vinext" },
  robots: { index: false, follow: true },
};

const LINKS = [
  { href: "/", label: "Home", detail: "What vinext is and how to start." },
  { href: "/readme", label: "Documentation", detail: "The full project README." },
  {
    href: "/compatibility",
    label: "Compatibility",
    detail: "Next.js deploy-suite results, run against vinext.",
  },
  {
    href: "/benchmarks",
    label: "Benchmarks",
    detail: "Build time, dev startup, and bundle size over time.",
  },
] as const;

export default function NotFound() {
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col px-6 pb-24 pt-24">
      <Text variant="secondary" size="sm">
        404
      </Text>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight text-kumo-default sm:text-5xl">
        That page does not exist
      </h1>
      <p className="mt-4 text-kumo-subtle">
        The URL may be out of date, or the page may have moved. Everything on vinext.dev is listed
        below.
      </p>

      <ul className="mt-10 flex flex-col divide-y divide-kumo-hairline border-y border-kumo-hairline">
        {LINKS.map(({ href, label, detail }) => (
          <li key={href}>
            <Link
              href={href}
              className="flex flex-col gap-1 py-4 transition-colors hover:bg-kumo-elevated"
            >
              <span className="font-medium text-kumo-default">{label}</span>
              <span className="text-sm text-kumo-subtle">{detail}</span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="mt-10">
        <LinkButton variant="secondary" href="https://github.com/cloudflare/vinext" external>
          Report a broken link on GitHub
        </LinkButton>
      </div>
    </section>
  );
}
