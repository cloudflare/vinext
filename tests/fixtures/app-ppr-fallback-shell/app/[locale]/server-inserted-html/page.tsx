"use client";

import { useServerInsertedHTML } from "next/navigation";

export default function Page() {
  useServerInsertedHTML(() => <style id="static-inserted-html">{"main { color: green; }"}</style>);

  let flushes = 0;
  useServerInsertedHTML(() => {
    if (++flushes === 1) return null;
    return <style id="late-inserted-html">{"main { font-weight: bold; }"}</style>;
  });

  return <main id="static-page">Static page</main>;
}
