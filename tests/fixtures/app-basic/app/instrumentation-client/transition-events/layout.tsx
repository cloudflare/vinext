import Link from "next/link";
import type { ReactNode } from "react";

// Ported from Next.js: test/e2e/instrumentation-client-hook/app-router (app/layout.tsx)
// https://github.com/vercel/next.js/blob/v16.4.6/test/e2e/instrumentation-client-hook/app-router/app/layout.tsx
const base = "/instrumentation-client/transition-events";

export default function TransitionEventsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ul>
        <li>
          <Link href={base}>Home</Link>
        </li>
        <li>
          <Link href={`${base}/some-page`} prefetch={true}>
            Some Page
          </Link>
        </li>
        <li>
          <Link href={`${base}/dashboard`}>Dashboard</Link>
        </li>
        <li>
          <Link href={`${base}/blog/hello`}>Blog post</Link>
        </li>
      </ul>
      {children}
    </>
  );
}
