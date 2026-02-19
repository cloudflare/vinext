"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <p data-testid="count">Count: {count}</p>
      <button data-testid="increment" onClick={() => setCount((c) => c + 1)}>
        Increment
      </button>
    </div>
  );
}
