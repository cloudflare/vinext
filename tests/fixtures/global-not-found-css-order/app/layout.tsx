// Root layout for the global-not-found CSS-ordering fixture.
//
// The layout imports red first and green second. On matched routes (e.g. `/`),
// green wins the cascade.
//
// On route-miss 404s the global-not-found document replaces this layout
// entirely (see createAppFallbackRenderer in app-fallback-renderer.ts), so the
// layout's green must NOT appear on the 404 — otherwise it would override
// global-not-found's own shared/distinct CSS and break the cascade. Mirrors
// Next.js:
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/initial-css-order/app/layout.tsx
import "./red.css";
import "./green.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
