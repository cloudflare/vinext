/**
 * Next.js compat: ISR layout with Date.now() for revalidation testing
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-rendering/app/isr-multiple/layout.js
 */
import { use } from "react";

async function getData() {
  return {
    message: "hello from layout",
    now: Date.now(),
  };
}

export default function IsrLayout(props: { children: React.ReactNode }) {
  const data = use(getData());

  return (
    <>
      <h1 id="layout-message">{data.message}</h1>
      <p id="layout-now">{data.now}</p>
      {props.children}
    </>
  );
}
