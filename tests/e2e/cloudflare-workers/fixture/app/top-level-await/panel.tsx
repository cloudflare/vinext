"use client";

import "./panel.css";

// workerd evaluates every module in global scope, even one imported during a
// request, where timers and I/O are disallowed: only an await that settles on
// the microtask queue can run at the top level.
await Promise.resolve();

export function Panel() {
  return (
    <p className="top-level-await-panel" data-testid="top-level-await-panel">
      panel
    </p>
  );
}
