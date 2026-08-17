"use client";

import { useState } from "react";

// State owned by the shared layout, so it only resets if the layout remounts.
export function LayoutState() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <p data-testid="layout-count">Layout count: {count}</p>
      <button data-testid="layout-increment" onClick={() => setCount((c) => c + 1)}>
        Increment layout counter
      </button>
    </div>
  );
}
