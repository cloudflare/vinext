import { connection } from "next/server";

// The e2e test answers this upstream and counts its requests.
export default async function FetchCacheSwrPage() {
  await connection();
  const response = await fetch("https://upstream.test/fetch-cache-swr", {
    next: { revalidate: 1 },
  });
  return <output data-testid="fetch-cache-value">{await response.text()}</output>;
}
