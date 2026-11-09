// Used by E2E: nextjs-compat/segment-cache-dynamic-params.spec.ts. next.config
// has a fallback rewrite for this route's unlisted params.
export const dynamicParams = false;

export function generateStaticParams() {
  return [{ slug: "listed" }];
}

export default async function DynamicParamsFallbackPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <p id="dynamic-params-fallback-page">{`listed page ${slug}`}</p>;
}
