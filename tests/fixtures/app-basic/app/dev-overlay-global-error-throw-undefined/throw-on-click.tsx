"use client";

import { useState } from "react";

export function ThrowOnClick() {
  const [shouldThrow, setShouldThrow] = useState(false);
  if (shouldThrow) {
    throw new Error("render error before global-error throws undefined");
  }
  return (
    <button data-testid="trigger-global-error-throw-undefined" onClick={() => setShouldThrow(true)}>
      Trigger
    </button>
  );
}
