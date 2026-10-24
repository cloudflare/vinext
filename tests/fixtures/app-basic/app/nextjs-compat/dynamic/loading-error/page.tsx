"use client";

// In the App Router, Next.js's next/dynamic is React.lazy inside Suspense with no
// error boundary of its own, so a failed load reaches the route's error.tsx.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/lazy-dynamic/loadable.tsx
import { useState } from "react";
import dynamic from "next/dynamic";

const FailingLoad = dynamic(
  () => Promise.reject<{ default: () => null }>(new Error("dynamic chunk failed to load")),
  { loading: () => <p id="dynamic-loading">Loading...</p> },
);

const ThrowingRender = dynamic(
  () =>
    Promise.resolve({
      default: function ThrowingComponent(): never {
        throw new Error("dynamic component threw while rendering");
      },
    }),
  { loading: () => <p id="dynamic-loading">Loading...</p> },
);

export default function Page() {
  const [shown, setShown] = useState<"load" | "render" | null>(null);
  return (
    <div>
      <button id="show-failing-load" onClick={() => setShown("load")}>
        Show failing load
      </button>
      <button id="show-throwing-render" onClick={() => setShown("render")}>
        Show throwing render
      </button>
      {shown === "load" ? <FailingLoad /> : null}
      {shown === "render" ? <ThrowingRender /> : null}
    </div>
  );
}
