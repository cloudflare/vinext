"use client";

import { use } from "react";

// A client page that reads its searchParams prop.
export default function ClientSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  return (
    <main>
      <p id="client-page-query">client page query {use(searchParams).q ?? "none"}</p>
    </main>
  );
}
