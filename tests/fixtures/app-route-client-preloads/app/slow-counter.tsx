"use client";

import { useState } from "react";

// Loads a beat late on the server, so a first render that didn't wait for its
// route's client references would reach it before it has loaded.
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
