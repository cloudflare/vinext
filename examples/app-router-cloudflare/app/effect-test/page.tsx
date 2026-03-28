"use client";

import { useEffect, useState } from "react";

// Regression test for https://github.com/cloudflare/vinext/issues/695
// useEffect callbacks were never firing after RSC hydration because
// createFromReadableStream was awaited before being passed to hydrateRoot,
// which blocked hydration until the entire RSC stream was consumed.
export default function EffectTestPage() {
  const [fired, setFired] = useState(false);
  const [count, setCount] = useState(0);

  useEffect(() => {
    setFired(true);
  }, []);

  return (
    <div>
      <p data-testid="effect-status">{fired ? "effect-fired" : "effect-pending"}</p>
      <p data-testid="count">Count: {count}</p>
      <button data-testid="increment" onClick={() => setCount((c) => c + 1)}>
        Increment
      </button>
    </div>
  );
}
