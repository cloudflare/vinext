/**
 * Next.js compat: Slow static page (tests parallel data fetching)
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-rendering/app/static-only/slow/page.js
 *
 * NOTE: Delay reduced from 5s to 1s to keep vinext tests fast.
 */
import { use } from "react";

export const revalidate = false;

async function getData() {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return {
    message: "hello from slow page",
  };
}

export default function SlowStaticPage() {
  const data = use(getData());
  return (
    <>
      <p id="slow-page-message">{data.message}</p>
    </>
  );
}
