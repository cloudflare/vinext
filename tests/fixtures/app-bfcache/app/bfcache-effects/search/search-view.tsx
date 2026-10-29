"use client";

import { useEffect, useState } from "react";
import { openConnection } from "../effect-log";
import { useEffectProbe } from "../effect-probe";

export function SearchView({ q }: { q: string }) {
  const instance = useEffectProbe("search");
  const [count, setCount] = useState(0);
  // Only this effect depends on the query, so only it re-runs when q changes.
  useEffect(() => openConnection(`search-query:${q}#${instance}`), [q, instance]);

  return (
    <div>
      <h2>Search {q}</h2>
      <button data-testid="increment-search" onClick={() => setCount((value) => value + 1)}>
        Increment
      </button>
      <span data-testid="count-search">Count: {count}</span>
    </div>
  );
}
