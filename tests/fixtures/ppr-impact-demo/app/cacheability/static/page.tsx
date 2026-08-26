import { cacheLife } from "next/cache";

export default async function StaticCacheabilityPage() {
  "use cache";
  cacheLife("minutes");
  return <p id="cacheability-result">static page</p>;
}
