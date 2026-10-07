import type { ReactNode } from "react";
import { cacheLife } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

async function getPolicy(): Promise<string> {
  "use cache";
  cacheLife({ stale: 45, revalidate: 60, expire: 300 });
  return "prefetch-redirect-session";
}

export default async function LayoutGuardCacheLife({ children }: { children: ReactNode }) {
  const sessionCookie = await getPolicy();
  if (!(await cookies()).has(sessionCookie)) {
    redirect("/nextjs-compat/prefetch-redirect/target");
  }
  return children;
}
