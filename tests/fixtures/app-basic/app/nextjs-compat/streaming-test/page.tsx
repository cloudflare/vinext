import { Suspense } from "react";
async function SlowContent() {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return <p id="streamed-content">Streamed content loaded</p>;
}
export default function Page() {
  return (
    <div>
      <h1 id="streaming-page">Streaming Test</h1>
      <Suspense fallback={<p id="suspense-fallback">Loading content...</p>}>
        <SlowContent />
      </Suspense>
    </div>
  );
}
