// Ported from Next.js: test/e2e/app-dir/cache-components-allow-otel-spans/cache-components-allow-otel-spans.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/cache-components-allow-otel-spans/cache-components-allow-otel-spans.test.ts
// An inline "use cache" page that receives props must still prerender its
// generateStaticParams paths at build time.
export function generateStaticParams() {
  return [{ slug: "prerendered" }];
}

// Page metadata functions receive the page's props too, so they also leave
// searchParams out of their cache key and serialized arguments.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  "use cache";
  return { title: `use cache page props ${(await params).slug}` };
}

export default async function InlineUseCachePropsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  "use cache";
  return <h1 data-testid="use-cache-page-props-slug">{(await params).slug}</h1>;
}
