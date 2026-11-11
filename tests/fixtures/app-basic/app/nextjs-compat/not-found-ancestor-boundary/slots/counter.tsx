"use client";

import { useState } from "react";

export function SlotsCounter() {
  const [count, setCount] = useState(0);
  return (
    <button id="not-found-ancestor-boundary-slots-counter" onClick={() => setCount(count + 1)}>
      count:{count}
    </button>
  );
}
