/**
 * Next.js compat: global-error/basic — client component that throws during SSR
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/basic/app/ssr/page.js
 */
"use client";

export default function Page() {
  throw new Error("client page error");
}
