/**
 * Next.js compat: SSR-only layout with async data
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-rendering/app/ssr-only/layout.js
 */
import { use } from "react";

export const revalidate = 0;

async function getData() {
  return {
    message: "hello from layout",
  };
}

export default function SsrLayout(props: { children: React.ReactNode }) {
  const data = use(getData());

  return (
    <>
      <h1 id="layout-message">{data.message}</h1>
      {props.children}
    </>
  );
}
