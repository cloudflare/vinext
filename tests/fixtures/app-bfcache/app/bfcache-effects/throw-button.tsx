"use client";

import { useState } from "react";

// Throws while rendering once clicked, so the nearest error.tsx catches it.
export function ThrowButton({ name }: { name: string }) {
  const [thrown, setThrown] = useState(false);
  if (thrown) throw new Error(`${name} threw`);
  return (
    <button data-testid={`throw-${name}`} onClick={() => setThrown(true)}>
      Throw
    </button>
  );
}
