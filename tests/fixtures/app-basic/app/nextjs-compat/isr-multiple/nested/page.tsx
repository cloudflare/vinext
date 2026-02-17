/**
 * Next.js compat: ISR page with revalidate=1 and Date.now()
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-rendering/app/isr-multiple/nested/page.js
 */
import { use } from "react";

export const revalidate = 1;

async function getData() {
  return {
    message: "hello from page",
    now: Date.now(),
  };
}

export default function IsrNestedPage() {
  const data = use(getData());

  return (
    <>
      <p id="page-message">{data.message}</p>
      <p id="page-now">{data.now}</p>
    </>
  );
}
