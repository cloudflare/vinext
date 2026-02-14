"use client";
import { useState } from "react";

export function Counter({ label = "Count" }: { label?: string }) {
  const [count, setCount] = useState(0);
  return (
    <div style={{ padding: "0.5rem", border: "1px solid #ddd", borderRadius: "4px", display: "inline-block" }}>
      <span>{label}: {count}</span>
      <button onClick={() => setCount(c => c + 1)} style={{ marginLeft: "0.5rem" }}>+</button>
    </div>
  );
}

