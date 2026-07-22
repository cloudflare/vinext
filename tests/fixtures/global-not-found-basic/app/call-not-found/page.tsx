import { notFound } from "next/navigation";

// Mirrors Next.js fixture:
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-not-found/basic/app/call-not-found/page.tsx
//
// When a page calls notFound(), the regular not-found.tsx boundary (or the
// framework default) is rendered INSIDE the root layout — not the
// global-not-found document.

export default function Page() {
  notFound();
}
