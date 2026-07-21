"use client";

import { useState } from "react";

export default function Template({ children }: { children: React.ReactNode }) {
  const [count, setCount] = useState(0);

  return (
    <>
      <h1 data-testid="client-template-count">Template {count}</h1>
      <button data-testid="client-template-increment" onClick={() => setCount(count + 1)}>
        Increment
      </button>
      {children}
    </>
  );
}
