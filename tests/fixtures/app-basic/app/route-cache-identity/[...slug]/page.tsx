export const revalidate = 3600;

export default async function CacheIdentityCatchAllPage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  return <h1>CACHE_IDENTITY_CATCH_ALL:{(await params).slug.join("/")}</h1>;
}
