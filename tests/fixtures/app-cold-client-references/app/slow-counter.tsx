"use client";

import { useState } from "react";

// Resolves this module's load a beat after the Flight stream references it,
// so the first SSR render reaches it before it has loaded.
if (typeof window === "undefined") {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

export function SlowCounter() {
  const [count, setCount] = useState(0);
  return (
    <button data-testid="slow-counter" onClick={() => setCount(count + 1)}>
      count {count}
    </button>
  );
}
