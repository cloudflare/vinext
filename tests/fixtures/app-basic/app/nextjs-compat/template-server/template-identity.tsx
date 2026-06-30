"use client";

import { useState } from "react";

export function TemplateIdentity({ testId }: { testId: string }) {
  const [count, setCount] = useState(0);

  return (
    <>
      <span data-testid={testId}>{count}</span>
      <button data-testid={`${testId}-increment`} onClick={() => setCount(count + 1)}>
        Increment
      </button>
    </>
  );
}
