import { connection } from "next/server";
import { Suspense } from "react";

async function SlowSection() {
  await new Promise((resolve) => setTimeout(resolve, 8000));
  return <p id="streaming-section">Streamed</p>;
}

export default async function RefreshDuringNavigationStreamingPage() {
  // Dynamic, so each request renders it and builds never wait on the delay.
  await connection();
  return (
    <>
      <h1 id="streaming-page">Streaming</h1>
      <p id="streaming-rendered-at">{Date.now()}</p>
      <Suspense fallback={<p id="streaming-fallback">Loading</p>}>
        <SlowSection />
      </Suspense>
    </>
  );
}
