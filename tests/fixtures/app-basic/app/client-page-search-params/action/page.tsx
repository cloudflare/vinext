"use client";

import { use } from "react";
import { refreshClientPageSearchParams } from "./actions";

// A rewrite gives the action's re-render a query the page URL doesn't have.
export default function ActionClientPageSearchParamsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { q } = use(searchParams);

  return (
    <main>
      <p data-testid="action-client-page-q">{typeof q === "string" ? q : "(none)"}</p>
      <form action={refreshClientPageSearchParams}>
        <button type="submit" data-testid="action-client-page-submit">
          refresh
        </button>
      </form>
    </main>
  );
}
