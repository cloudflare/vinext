import { headers } from "next/headers";

export const revalidate = 60;

export default async function StaticToDynamicCacheabilityPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const requestHeaders = await headers();
  return <p>{`${slug}:${requestHeaders.get("x-probe-value") ?? "none"}`}</p>;
}
