// Mirrors Next.js fixture:
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/initial-css-order/app/layout.tsx
//
// The order of CSS imports matters: red.css is imported first, then green.css.
// On matched routes the layout wins (green wins over red), so the body should
// be green. On route-miss 404s the global-not-found document replaces the root
// layout — its `red.css` import must therefore win, regardless of the layout's
// imports.
import "./red.css";
import "./green.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
