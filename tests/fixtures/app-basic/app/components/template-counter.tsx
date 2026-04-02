"use client";

import { useState } from "react";

/**
 * Client counter used to verify template remount behavior.
 * Templates remount when navigation crosses their segment boundary,
 * so this counter should reset. But search param changes within the
 * same segment should NOT cause a remount, so the counter persists.
 */
export function TemplateCounter() {
  const [count, setCount] = useState(0);

  return (
    <div data-testid="template-counter">
      <span data-testid="template-count">Template count: {count}</span>
      <button data-testid="template-increment" onClick={() => setCount((c) => c + 1)}>
        +1
      </button>
    </div>
  );
}
