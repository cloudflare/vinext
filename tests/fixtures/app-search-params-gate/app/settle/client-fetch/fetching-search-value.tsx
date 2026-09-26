"use client";

import { use } from "react";
import { SearchValue } from "../../search-value";

// Suspends on its own data during SSR, as a suspense-enabled data library
// does. The test sets the URL of this app's /api/client-data route.
let data: Promise<string> | undefined;

function loadData(): Promise<string> {
  const url = Reflect.get(globalThis, "__SEARCH_PARAMS_GATE_DATA_URL__");
  data ??= fetch(String(url), { cache: "force-cache" }).then((response) => response.text());
  return data;
}

export function FetchingSearchValue() {
  const text = use(loadData());
  return (
    <>
      <span data-testid="client-data">{text}</span>
      <SearchValue />
    </>
  );
}
