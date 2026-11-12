import { Suspense } from "react";

// A hole: an uncached fetch, which each request makes.
async function Latest() {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT}/api/stamp`);
  return <p id="latest">{await response.text()}</p>;
}

export default function FeedPage() {
  return (
    <main>
      <h1 id="title">Feed</h1>
      <Suspense fallback={<p id="latest-loading">Loading latest…</p>}>
        <Latest />
      </Suspense>
    </main>
  );
}
