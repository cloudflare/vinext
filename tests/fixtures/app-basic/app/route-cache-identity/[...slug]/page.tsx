export const revalidate = 3600;

// Next.js only ISR-caches a dynamic-segment route that exports
// generateStaticParams (an empty list opts every path into on-demand ISR).
export function generateStaticParams() {
  return [];
}

export default async function CacheIdentityCatchAllPage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  return <h1>CACHE_IDENTITY_CATCH_ALL:{(await params).slug.join("/")}</h1>;
}
