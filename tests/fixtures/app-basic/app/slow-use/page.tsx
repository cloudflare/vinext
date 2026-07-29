import { use } from "react";

async function getData() {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return "ready";
}

// Ported from Next.js: test/e2e/app-dir/app/app/slow-page-with-loading/page.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/app/slow-page-with-loading/page.js
export default function SlowUsePage() {
  use(getData());

  return (
    <main>
      <h1>Slow use() Page</h1>
      <p>This synchronous page suspends with React.use().</p>
    </main>
  );
}
