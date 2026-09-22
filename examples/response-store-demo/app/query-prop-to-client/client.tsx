"use client";

import { use } from "react";

export default function QueryPropClient({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = use(searchParams);
  return <output data-testid="query-prop-to-client-value">{q || "(empty)"}</output>;
}
