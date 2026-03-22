"use client";

import { startTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export function FilterControls() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filter = searchParams.get("filter") ?? "alpha";

  function navigate(nextFilter: string) {
    startTransition(() => {
      router.push(`/nav-flash/query-sync?filter=${nextFilter}`, { scroll: false });
    });
  }

  return (
    <div>
      <p id="client-filter-label">Client filter: {filter}</p>
      <button id="query-filter-alpha" onClick={() => navigate("alpha")}>
        Alpha
      </button>
      <button id="query-filter-beta" onClick={() => navigate("beta")}>
        Beta
      </button>
    </div>
  );
}
