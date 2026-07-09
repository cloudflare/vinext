import React, { useState } from "react";
import dynamic from "next/dynamic";

const HeavyComponent = dynamic(
  async () => {
    if (typeof window !== "undefined") {
      await fetch("/dynamic-hydration-gate.txt", { cache: "no-store" });
    }
    return import("../components/heavy");
  },
  {
    loading: () => <p>Loading heavy component...</p>,
  },
);

export default function DynamicPage() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <h1>Dynamic Import Page</h1>
      <button data-testid="dynamic-increment" onClick={() => setCount((value) => value + 1)}>
        Count: {count}
      </button>
      <HeavyComponent label="Loaded dynamically" />
    </div>
  );
}
