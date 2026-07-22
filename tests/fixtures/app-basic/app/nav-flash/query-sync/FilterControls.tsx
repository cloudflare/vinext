"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

export function FilterControls() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filter = searchParams.get("q") ?? "";

  return (
    <div id="query-controls">
      <p id="hook-pathname">pathname: {pathname}</p>
      <p id="hook-query">q: {filter}</p>
      <Link href="/nav-flash/query-sync?q=react" id="link-react">
        React
      </Link>
      <Link href="/nav-flash/query-sync?q=vue" id="link-vue">
        Vue
      </Link>
      <Link href="/nav-flash/query-sync" id="link-clear">
        Clear
      </Link>
    </div>
  );
}
