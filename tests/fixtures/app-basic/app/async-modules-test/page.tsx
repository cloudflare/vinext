// Top-level await (async module) test fixture for the App Router.
// Verifies that pages using TLA render their resolved data instead of empty.
// Based on Next.js: test/e2e/async-modules/pages/index.jsx (adapted for App
// Router — the upstream async-modules suite is Pages-Router-only; this is the
// same TLA pattern wrapped in an App Router server component).
// https://github.com/vercel/next.js/blob/canary/test/e2e/async-modules/pages/index.jsx

const value = await Promise.resolve(42);
const text = await Promise.resolve("hello");

export default function AsyncModulesTestPage() {
  return (
    <main>
      <div id="app-value">{text}</div>
      <div id="page-value">{value}</div>
    </main>
  );
}
