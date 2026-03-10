import React, { Suspense, lazy } from "react";

// React.lazy simulates a dynamic import — renderToPipeableStream
// waits for lazy components to resolve, unlike renderToString which
// would render only the fallback or throw.
const LazyGreeting = lazy(
  () =>
    new Promise<{ default: React.ComponentType }>((resolve) => {
      // Resolve immediately — simulates a fast dynamic import
      resolve({
        default: () => <div data-testid="lazy-greeting">Hello from lazy component</div>,
      });
    }),
);

export default function SuspenseTestPage() {
  return (
    <div>
      <h1>Suspense Test</h1>
      <Suspense fallback={<div data-testid="loading">Loading...</div>}>
        <LazyGreeting />
      </Suspense>
    </div>
  );
}
