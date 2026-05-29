/**
 * Next.js compat: forbidden/basic — when a deep page calls `forbidden()` and the
 * intermediate layout segment has no `forbidden.tsx`, the boundary must escalate
 * to the nearest ancestor that does (here: the app root `forbidden.tsx`).
 *
 * Ported from Next.js: test/e2e/app-dir/forbidden/basic/app/dynamic-layout-without-forbidden/layout.js
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/forbidden/basic/app/dynamic-layout-without-forbidden/layout.js
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="escalate-forbidden-layout">
      <h2>Dynamic with Layout</h2>
      {children}
    </div>
  );
}
