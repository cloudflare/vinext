"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

export function FilterLinks() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("filter") ?? "";

  return (
    <div id="filter-links">
      <p id="hook-pathname">pathname: {pathname}</p>
      <p id="hook-filter">filter: {current}</p>
      <Link href="/nav-flash/link-sync?filter=active" id="link-active">
        Active
      </Link>
      <Link href="/nav-flash/link-sync?filter=completed" id="link-completed">
        Completed
      </Link>
      <Link href="/nav-flash/link-sync" id="link-clear">
        Clear
      </Link>
      <Link href="/nav-flash/list" id="link-list">
        Go to List
      </Link>
    </div>
  );
}
