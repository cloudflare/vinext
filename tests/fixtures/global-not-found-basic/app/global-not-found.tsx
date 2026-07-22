// Mirrors Next.js fixture:
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-not-found/basic/app/global-not-found.tsx
//
// `global-not-found.tsx` owns its own <html>/<body>. When present, vinext
// renders this module standalone for route-miss 404s, replacing the root
// layout (see createAppFallbackRenderer in app-fallback-renderer.ts).
//
// red.css is imported here so we can assert global-not-found CSS overrides
// the root layout's CSS — the global-not-found document fully replaces the
// layout, so its CSS link must appear after any layout CSS that may still
// be served (or, ideally, instead of it). Mirrors:
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/initial-css-order/app/global-not-found.tsx
import "./red.css";

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
