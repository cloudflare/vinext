"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button id="layout-counter" onClick={() => setCount(count + 1)}>
      count {count}
    </button>
  );
}
