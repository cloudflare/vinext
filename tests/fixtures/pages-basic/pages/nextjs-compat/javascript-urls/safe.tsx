// Ported from Next.js: test/e2e/app-dir/javascript-urls/pages/pages/safe.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/javascript-urls/pages/pages/safe.tsx
export default function Page() {
  return (
    <p id="canary">
      This page is used as a navigation target to ensure SPA navigation continues to work after
      pushing/redirecting/linking to a javascript URL.
    </p>
  );
}
