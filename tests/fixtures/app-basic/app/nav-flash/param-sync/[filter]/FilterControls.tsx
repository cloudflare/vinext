"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";

export function FilterControls() {
  const params = useParams();
  const pathname = usePathname();

  return (
    <div id="filter-controls">
      <p id="hook-pathname">pathname: {pathname}</p>
      <p id="hook-params">params.filter: {String(params.filter ?? "")}</p>
      <Link href="/nav-flash/param-sync/active" id="link-active">
        Active
      </Link>
      <Link href="/nav-flash/param-sync/completed" id="link-completed">
        Completed
      </Link>
    </div>
  );
}
