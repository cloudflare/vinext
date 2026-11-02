"use client";

import { useEffect, useState } from "react";

export default function OptionalCanvasPage() {
  const [result, setResult] = useState("unloaded");
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return (
    <button
      disabled={!ready}
      onClick={async () => {
        try {
          const { default: canvas } = await import("@/__test_packages__/optional-canvas/index.cjs");
          setResult(canvas.backend);
        } catch (error) {
          setResult(error.message);
        }
      }}
    >
      {result}
    </button>
  );
}
