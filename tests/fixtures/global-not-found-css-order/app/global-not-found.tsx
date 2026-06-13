// `global-not-found.tsx` owns its own <html>/<body> and replaces the root
// layout for route-miss 404s (Next.js 16 `experimental.globalNotFound`).
//
// It imports two stylesheets whose order matters: `gnf-a.css` paints the body
// blue, then `gnf-b.css` paints it red. Because gnf-b is imported last, red
// must win the cascade — this asserts global-not-found's own CSS import order
// is preserved in production.
//
// Crucially, global-not-found imports CSS files the root layout does NOT, so
// its red rule survives minification (it is never merged with the layout's
// green). The remaining failure mode the fix addresses is global-not-found
// inheriting the root layout's CSS chunk in production: without React split
// into its own chunk, the bundler colocates the layout's stylesheet with the
// shared RSC entry chunk that global-not-found imports for React helpers, so
// the 404 document links the layout's green last and green wins. Mirrors:
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/initial-css-order/app/global-not-found.tsx
// See https://github.com/cloudflare/vinext/issues/1549.
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
