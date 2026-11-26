import { Suspense, ViewTransition } from "react";

export const dynamic = "force-dynamic";

async function Slow() {
  await new Promise((resolve) => setTimeout(resolve, 400));
  return <p data-testid="vt-reveal-content">Loaded</p>;
}

export default function RevealPage() {
  return (
    <main data-testid="vt-page-reveal">
      <Suspense
        fallback={
          <ViewTransition exit="skeleton-exit">
            <p>Loading</p>
          </ViewTransition>
        }
      >
        <ViewTransition enter="content-enter" default="none">
          <Slow />
        </ViewTransition>
      </Suspense>
    </main>
  );
}
