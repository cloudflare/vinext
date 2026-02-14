"use client";

import { usePathname, useSearchParams } from "next/navigation";

/**
 * A "use client" component that calls usePathname() and useSearchParams().
 * This exercises the SSR nav context propagation — during SSR, these hooks
 * need the pathname/searchParams from the RSC environment's request context.
 */
export function ClientNavInfo() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const q = searchParams.get("q") ?? "";

  return (
    <div data-testid="client-nav-info">
      <span data-testid="client-pathname">{pathname}</span>
      <span data-testid="client-search-q">{q}</span>
    </div>
  );
}
