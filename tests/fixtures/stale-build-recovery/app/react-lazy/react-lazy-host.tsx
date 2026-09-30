"use client";

import { lazy, Suspense, useState } from "react";

const ReactLazyThing = lazy(() => import("./react-lazy-thing"));
const BareThing = lazy(() => import("./bare-thing"));

export function ReactLazyHost() {
  const [shown, setShown] = useState<"bare" | "none" | "thing">("none");

  return (
    <section>
      <button id="show-lazy" onClick={() => setShown("thing")} type="button">
        Show lazy
      </button>
      <button id="show-bare" onClick={() => setShown("bare")} type="button">
        Show bare
      </button>
      <Suspense fallback={<p id="lazy-loading">loading</p>}>
        {shown === "thing" ? <ReactLazyThing /> : null}
        {shown === "bare" ? <BareThing /> : null}
      </Suspense>
    </section>
  );
}
