/**
 * Next.js compat: SSR-only nested page with async data
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-rendering/app/ssr-only/nested/page.js
 */
import { use } from "react";

async function getData() {
  return {
    message: "hello from page",
  };
}

export default function NestedPage() {
  const data = use(getData());

  return (
    <>
      <p id="page-message">{data.message}</p>
    </>
  );
}
