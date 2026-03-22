"use client";

import { startTransition } from "react";
import { useParams, useRouter } from "next/navigation";

export function FilterControls() {
  const router = useRouter();
  const params = useParams<{ filter: string }>();
  const filter = params.filter ?? "alpha";

  function navigate(nextFilter: string) {
    startTransition(() => {
      router.push(`/nav-flash/param-sync/${nextFilter}`, { scroll: false });
    });
  }

  return (
    <div>
      <p id="client-param-label">Client param: {filter}</p>
      <button id="param-filter-alpha" onClick={() => navigate("alpha")}>
        Alpha
      </button>
      <button id="param-filter-beta" onClick={() => navigate("beta")}>
        Beta
      </button>
    </div>
  );
}
