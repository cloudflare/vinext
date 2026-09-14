import { cacheLife, cacheTag } from "next/cache";
import { connection } from "next/server";

let routeRenders = 0;

async function getCachedValue(prefix: string): Promise<string> {
  "use cache";
  cacheLife({ revalidate: 1, expire: 60 });
  cacheTag("response-store-use-cache");
  return `${prefix}:${crypto.randomUUID()}`;
}

export default async function UseCachePage() {
  await connection();
  routeRenders += 1;
  return (
    <>
      <output data-testid="use-cache-value">{await getCachedValue("value")}</output>
      <output data-testid="use-cache-route-renders">{routeRenders}</output>
    </>
  );
}
