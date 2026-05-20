// Top-level await (async module) test fixture.
// Verifies that pages using TLA render their resolved data instead of empty.
// Ported from Next.js: test/e2e/async-modules/pages/index.jsx
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
