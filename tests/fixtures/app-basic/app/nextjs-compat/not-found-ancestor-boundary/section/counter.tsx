"use client";

import { useState } from "react";

export function SectionCounter() {
  const [count, setCount] = useState(0);
  return (
    <button id="not-found-ancestor-boundary-counter" onClick={() => setCount(count + 1)}>
      count:{count}
    </button>
  );
}
