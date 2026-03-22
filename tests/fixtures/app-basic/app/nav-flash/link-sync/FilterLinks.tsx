"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

export function FilterLinks() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filter = searchParams.get("filter") ?? "alpha";

  return (
    <div>
      <p id="link-client-filter-label">Client filter: {filter}</p>
      <Link
        id="link-filter-alpha"
        href="/nav-flash/link-sync?filter=alpha"
        prefetch={false}
        scroll={false}
        onMouseEnter={() => router.prefetch("/nav-flash/link-sync?filter=alpha")}
        onFocus={() => router.prefetch("/nav-flash/link-sync?filter=alpha")}
      >
        Alpha
      </Link>
      <Link
        id="link-filter-beta"
        href="/nav-flash/link-sync?filter=beta"
        prefetch={false}
        scroll={false}
        onMouseEnter={() => router.prefetch("/nav-flash/link-sync?filter=beta")}
        onFocus={() => router.prefetch("/nav-flash/link-sync?filter=beta")}
      >
        Beta
      </Link>
    </div>
  );
}
