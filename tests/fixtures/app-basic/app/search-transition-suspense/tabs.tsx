"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function Tabs() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <nav>
      <button
        data-testid="search-transition-archived-tab"
        onClick={() => {
          startTransition(() => {
            router.replace("?archived=1", { scroll: false });
          });
        }}
      >
        Archived
      </button>
      <button
        data-testid="search-transition-archived-hash-tab"
        onClick={() => {
          startTransition(() => {
            router.replace("?archived=1#archived-items");
          });
        }}
      >
        Archived (jump to list)
      </button>
      <Link data-testid="search-transition-archived-hash-link" href="?archived=1#archived-items">
        Archived link (jump to list)
      </Link>
      <Link
        data-testid="search-transition-prefetched-link"
        href="/search-transition-suspense/prefetched"
      >
        Prefetched page
      </Link>
      <span data-testid="search-transition-pending">{String(isPending)}</span>
    </nav>
  );
}
