import { headers } from "next/headers";

export const revalidate = 60;

export default async function CacheProbeHeadersPage() {
  const value = (await headers()).get("x-cache-probe") ?? "missing";
  return <main>cache-probe header {value}</main>;
}
