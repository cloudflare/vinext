/**
 * Next.js compat: not-found/basic — layout without its own not-found boundary
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found/basic/app/dynamic-layout-without-not-found/layout.js
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <h1>Dynamic with Layout</h1>
      {children}
    </div>
  );
}
