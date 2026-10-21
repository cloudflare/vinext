"use client";

import { useState } from "react";

export function SegmentCounter() {
  const [count, setCount] = useState(0);
  return (
    <button id="not-found-layout-segment-counter" onClick={() => setCount(count + 1)}>
      count:{count}
    </button>
  );
}
