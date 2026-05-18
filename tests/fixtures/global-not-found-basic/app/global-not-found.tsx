// Mirrors Next.js fixture:
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-not-found/basic/app/global-not-found.tsx
//
// `global-not-found.tsx` owns its own <html>/<body>. When present, vinext
// renders this module standalone for route-miss 404s, replacing the root
// layout (see createAppFallbackRenderer in app-fallback-renderer.ts).

export default function GlobalNotFound() {
  return (
    // html tag is intentionally distinct from the root layout's so tests
    // can assert which document was rendered.
    <html data-global-not-found="true">
      <body>
        <h1 id="global-error-title">global-not-found</h1>
      </body>
    </html>
  );
}
