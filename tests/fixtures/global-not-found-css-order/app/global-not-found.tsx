// `global-not-found.tsx` owns its own <html>/<body> and replaces the root
// layout for route-miss 404s (Next.js 16 `experimental.globalNotFound`).
//
// It imports the same `red.css` file as the root layout. Production builds must
// still give global-not-found an isolated CSS resource; otherwise Vite/Rolldown
// dedupes the shared red import into the layout bundle where green wins.
//
// Without isolation, the 404 document links the layout's CSS bundle and green
// wins. Mirrors:
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/initial-css-order/app/global-not-found.tsx
// See https://github.com/cloudflare/vinext/issues/1549.
import "./red.css";

export default function GlobalNotFound() {
  return (
    <html data-global-not-found="true">
      <body>
        <h1 id="global-error-title">global-not-found</h1>
      </body>
    </html>
  );
}
