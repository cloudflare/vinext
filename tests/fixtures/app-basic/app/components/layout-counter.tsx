"use client";

import { useState } from "react";

/**
 * Client counter used to verify layout persistence.
 * If the layout remounts, this counter resets to 0.
 * If the layout persists across navigation, the counter retains its value.
 */
export function LayoutCounter() {
  const [count, setCount] = useState(0);

  return (
    <div data-testid="layout-counter">
      <span data-testid="layout-count">Layout count: {count}</span>
      <button data-testid="layout-increment" onClick={() => setCount((c) => c + 1)}>
        +1
      </button>
    </div>
  );
}
