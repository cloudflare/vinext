import React, { Suspense, lazy } from "react";

const DelayedChunk = lazy(
  () =>
    new Promise<{ default: React.ComponentType }>((resolve) => {
      setTimeout(() => {
        resolve({
          default: function DelayedChunkImpl() {
            return (
              <div data-testid="gssp-streamed-content">Delayed gSSP stream content loaded</div>
            );
          },
        });
      }, 600);
    }),
);

export async function getServerSideProps({
  res,
}: {
  res: { setHeader: (key: string, value: string) => void };
}) {
  // Simulate a userland length that would be stale once the streamed HTML starts flowing.
  res.setHeader("Content-Length", "1");
  return { props: {} };
}

export default function StreamingGsspContentLengthPage() {
  return (
    <main>
      <h1>Streaming gSSP Content-Length Test</h1>
      <Suspense
        fallback={<div data-testid="gssp-streaming-fallback">Loading delayed gSSP chunk...</div>}
      >
        <DelayedChunk />
      </Suspense>
    </main>
  );
}
