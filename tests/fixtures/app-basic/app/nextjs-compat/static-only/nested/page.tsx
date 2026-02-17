/**
 * Next.js compat: Static-only nested page with async data
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-rendering/app/static-only/nested/page.js
 */
import { use } from "react";

export const revalidate = false;

async function getData() {
  return {
    message: "hello from page",
  };
}

export default function StaticNestedPage() {
  const data = use(getData());
  return (
    <>
      <p id="page-message">{data.message}</p>
    </>
  );
}
