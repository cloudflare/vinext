/**
 * Next.js compat: unauthorized/basic — when a deep page calls `unauthorized()`
 * and the intermediate layout segment has no `unauthorized.tsx`, the boundary
 * must escalate to the nearest ancestor that does (the root `unauthorized.tsx`).
 *
 * Ported from Next.js: test/e2e/app-dir/unauthorized/basic/app/dynamic-layout-without-unauthorized/layout.js
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/unauthorized/basic/app/dynamic-layout-without-unauthorized/layout.js
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="escalate-unauthorized-layout">
      <h2>Dynamic with Layout</h2>
      {children}
    </div>
  );
}
