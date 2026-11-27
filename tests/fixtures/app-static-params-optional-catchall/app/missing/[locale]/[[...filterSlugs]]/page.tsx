// Ported from Next.js: test/e2e/app-dir/metadata-streaming-cache-components/app/[locale]/[[...filterSlugs]]/page.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-streaming-cache-components/app/[locale]/[[...filterSlugs]]/page.tsx
// A set without the optional catch-all leaves the route unprerendered
// (build/static-paths/app.ts hadAllParamsGenerated) instead of failing the build.
export function generateStaticParams() {
  return [{ locale: "en" }];
}

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; filterSlugs?: string[] }>;
}) {
  const { locale, filterSlugs } = await params;
  return (
    <main>
      {locale}: {filterSlugs ? filterSlugs.join("|") : "undefined"}
    </main>
  );
}
