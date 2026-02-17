/**
 * Next.js compat: Slow SSR layout (tests parallel data fetching)
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-rendering/app/ssr-only/slow/layout.js
 *
 * NOTE: Delay reduced from 5s to 1s to keep vinext tests fast.
 * The parallelism assertion threshold is adjusted accordingly.
 */
import { use } from "react";

async function getData() {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return {
    message: "hello from slow layout",
  };
}

export default function SlowSsrLayout(props: { children: React.ReactNode }) {
  const data = use(getData());
  return (
    <>
      <h1 id="slow-layout-message">{data.message}</h1>
      {props.children}
    </>
  );
}
