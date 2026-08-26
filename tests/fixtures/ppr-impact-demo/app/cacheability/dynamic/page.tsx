import { headers } from "next/headers";

export const revalidate = 60;

export default async function DynamicCacheabilityPage() {
  const requestHeaders = await headers();
  return (
    <p id="cacheability-result">
      probe={requestHeaders.get("x-vinext-cacheability-probe") ?? "none"};secret=
      {requestHeaders.get("x-vinext-prerender-secret") ?? "none"}
    </p>
  );
}
