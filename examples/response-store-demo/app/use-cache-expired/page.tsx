import { cacheLife } from "next/cache";
import { connection } from "next/server";

async function getCachedValue(): Promise<string> {
  "use cache";
  cacheLife({ revalidate: 1, expire: 2 });
  return crypto.randomUUID();
}

export default async function UseCacheExpiredPage() {
  await connection();
  return <output data-testid="expired-cache-value">{await getCachedValue()}</output>;
}
