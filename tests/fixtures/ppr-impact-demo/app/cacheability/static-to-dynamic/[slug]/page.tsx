import { headers } from "next/headers";

export const revalidate = 60;

// Next.js only raises the static-to-dynamic error for SSG routes, so the
// dynamic segment needs generateStaticParams.
export function generateStaticParams() {
  return [{ slug: "runtime" }];
}

export default async function StaticToDynamicCacheabilityPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const requestHeaders = await headers();
  return <p>{`${slug}:${requestHeaders.get("x-probe-value") ?? "none"}`}</p>;
}
