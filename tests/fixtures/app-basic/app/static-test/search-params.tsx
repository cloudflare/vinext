"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

export default function ForceStaticSearchParams() {
  const searchParams = useSearchParams();
  // Counts the search params objects the component has seen: the hydrated one
  // stays when the browser URL has the same query.
  const [objects, setObjects] = useState(0);
  useEffect(() => setObjects((count) => count + 1), [searchParams]);

  return (
    <p data-testid="force-static-search-params" data-search-params-objects={objects}>
      {searchParams.get("value") ?? "N/A"}
    </p>
  );
}
