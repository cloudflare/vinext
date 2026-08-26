import { cookies } from "next/headers";

export const revalidate = 60;

export default async function CacheProbeCookiesPage() {
  const value = (await cookies()).get("cache-probe")?.value ?? "missing";
  return <main>cache-probe cookie {value}</main>;
}
