"use client";

import { useState } from "react";

export function CacheLayoutCounter() {
  const [count, setCount] = useState(0);

  return (
    <button id="cdn-layout-counter" type="button" onClick={() => setCount((value) => value + 1)}>
      Layout state: {count}
    </button>
  );
}
