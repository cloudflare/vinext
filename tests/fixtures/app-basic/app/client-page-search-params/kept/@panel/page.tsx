"use client";

import { use, useEffect, useState } from "react";

// First renders after the navigation to /other has kept the panel.
export default function KeptClientPagePanel({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tab } = use(searchParams);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  return (
    <p data-testid="kept-client-page-tab" data-hydrated={hydrated ? "true" : undefined}>
      {typeof tab === "string" ? tab : "(none)"}
    </p>
  );
}
