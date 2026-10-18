import type { ReactNode } from "react";
import { cacheLife } from "next/cache";
import { redirect } from "next/navigation";

async function getSession(): Promise<string | null> {
  "use cache";
  cacheLife({ stale: 45, revalidate: 60, expire: 300 });
  return null;
}

export default async function LayoutCacheLife({ children }: { children: ReactNode }) {
  if ((await getSession()) === null) {
    redirect("/nextjs-compat/prefetch-redirect/target");
  }
  return children;
}
