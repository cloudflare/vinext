"use client";

import { useState } from "react";

export function ErrorTrigger({ label }: { label: string }) {
  const [shouldThrow, setShouldThrow] = useState(false);

  if (shouldThrow) {
    throw new Error(`${label} reset collision error`);
  }

  return (
    <button data-testid={`${label}-error-trigger`} onClick={() => setShouldThrow(true)}>
      Trigger {label} error
    </button>
  );
}
