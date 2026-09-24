import { cacheLife } from "next/cache";
import { connection } from "next/server";

async function getCachedParamsValue(params: Promise<{ slug: string }>): Promise<string> {
  "use cache";
  cacheLife({ revalidate: 1, expire: 60 });
  const { slug } = await params;
  return `${slug}:${crypto.randomUUID()}`;
}

export default async function UseCacheParamsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await connection();
  return (
    <output data-testid="use-cache-params-value">{await getCachedParamsValue(params)}</output>
  );
}
