import { Suspense } from "react";

export const revalidate = 60;

async function DelayedContent() {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  return <p>streaming-complete</p>;
}

export default function StreamingCachePage() {
  return (
    <>
      <p>streaming-shell</p>
      <Suspense fallback={<p>streaming-fallback</p>}>
        <DelayedContent />
      </Suspense>
    </>
  );
}
