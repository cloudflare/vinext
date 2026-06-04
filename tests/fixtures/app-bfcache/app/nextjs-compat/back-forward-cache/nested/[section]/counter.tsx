"use client";

import { useState } from "react";

export function Counter({ id, label }: { id: string; label: string }) {
  const [count, setCount] = useState(0);

  return (
    <div>
      <span>{label}: </span>
      <button id={`increment-${id}`} onClick={() => setCount((value) => value + 1)}>
        Increment
      </button>
      <span id={`counter-${id}`}>Count: {count}</span>
    </div>
  );
}
