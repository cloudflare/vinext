import { Suspense } from "react";
async function SlowA() {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return <p id="content-a">Content A loaded</p>;
}
async function SlowB() {
  await new Promise((resolve) => setTimeout(resolve, 600));
  return <p id="content-b">Content B loaded</p>;
}
export default function Page() {
  return (
    <div>
      <h1 id="nested-streaming-page">Nested Streaming Test</h1>
      <Suspense fallback={<p id="fallback-a">Loading A...</p>}>
        <SlowA />
      </Suspense>
      <Suspense fallback={<p id="fallback-b">Loading B...</p>}>
        <SlowB />
      </Suspense>
    </div>
  );
}
