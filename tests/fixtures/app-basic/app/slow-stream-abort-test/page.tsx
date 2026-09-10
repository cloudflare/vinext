import { Suspense } from "react";

export const dynamic = "force-dynamic";

async function SlowSection() {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return <p>slow section done</p>;
}

export default function SlowStreamAbortTestPage() {
  return (
    <main>
      <h1>slow stream abort test</h1>
      <Suspense fallback={<p>loading slow section...</p>}>
        <SlowSection />
      </Suspense>
    </main>
  );
}
