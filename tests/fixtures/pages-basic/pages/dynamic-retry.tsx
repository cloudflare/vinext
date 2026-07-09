import React, { useState } from "react";
import dynamic from "next/dynamic";

const RetryableDynamic = dynamic(
  async () => {
    if (typeof window !== "undefined") {
      const response = await fetch("/dynamic-retry-gate.txt");
      if (!response.ok) {
        throw new Error(`dynamic retry gate failed: ${response.status}`);
      }
    }
    return import("../components/retryable-dynamic");
  },
  {
    loading: ({ error, retry }) =>
      error ? (
        <button data-testid="retry-dynamic" onClick={retry}>
          Retry dynamic
        </button>
      ) : (
        <p>Loading retryable dynamic...</p>
      ),
  },
);

export default function DynamicRetryPage() {
  const [mounted, setMounted] = useState(true);

  return (
    <main>
      <button data-testid="toggle-dynamic" onClick={() => setMounted((value) => !value)}>
        Toggle dynamic
      </button>
      {mounted ? (
        <>
          <RetryableDynamic />
          <RetryableDynamic />
        </>
      ) : null}
    </main>
  );
}
