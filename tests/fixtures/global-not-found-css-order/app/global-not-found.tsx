// `global-not-found.tsx` owns its own <html>/<body> and replaces the root
// layout for route-miss 404s (Next.js 16 `experimental.globalNotFound`).
//
// It imports both:
//   - the same `red.css` file as the root layout, which must be isolated with a
//     private query so Vite/Rolldown cannot dedupe it into the layout bundle
//   - distinct global-not-found-only CSS files, which must not inherit the root
//     layout's green CSS through a shared framework/RSC chunk
//
// Without either guard, the 404 document links the layout's CSS bundle and
// green wins. Mirrors:
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/initial-css-order/app/global-not-found.tsx
// See https://github.com/cloudflare/vinext/issues/1549.
import "./red.css";
import "./gnf-a.css";
import "./gnf-b.css";

export default function GlobalNotFound() {
  return (
    <html data-global-not-found="true">
      <body>
        <h1 id="global-error-title">global-not-found</h1>
      </body>
    </html>
  );
}
