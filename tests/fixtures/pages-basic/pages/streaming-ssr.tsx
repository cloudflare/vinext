import React, { Suspense, lazy } from "react";

const DelayedChunk = lazy(
  () =>
    new Promise<{ default: React.ComponentType }>((resolve) => {
      // Keep the boundary pending long enough for production streaming tests
      // to observe the fallback before the final content arrives.
      setTimeout(() => {
        resolve({
          default: function DelayedChunkImpl() {
            return <div data-testid="streamed-content">Delayed stream content loaded</div>;
          },
        });
      }, 600);
    }),
);

export default function StreamingSsrPage() {
  return (
    <main>
      <h1>Streaming SSR Test</h1>
      <Suspense fallback={<div data-testid="streaming-fallback">Loading delayed chunk...</div>}>
        <DelayedChunk />
      </Suspense>
    </main>
  );
}
