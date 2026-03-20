"use client";
import { useState } from "react";
export function ClientChild({ greeting }: { greeting: string }) {
  const [count, setCount] = useState(0);
  return (
    <div id="client-child">
      <p id="server-greeting">{greeting}</p>
      <p id="click-count">{count}</p>
      <button id="increment-btn" onClick={() => setCount((c) => c + 1)}>
        +1
      </button>
    </div>
  );
}
