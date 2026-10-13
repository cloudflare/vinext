import { Suspense } from "react";
import { startRenderAbortProbe, waitForRenderAbortBoundary } from "../../lib/render-abort-probe";

// Client-disconnect coverage: tests/node-request-cancellation.test.ts

export const dynamic = "force-dynamic";

async function PendingBoundary({ id }: { id: string }) {
  await waitForRenderAbortBoundary(id);
  return <p id="render-abort-boundary">boundary finished</p>;
}

export default async function RenderAbortPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;
  if (!id) return <p>missing id</p>;
  await startRenderAbortProbe(id);
  return (
    <main>
      <h1>Render abort</h1>
      <Suspense fallback={<p>loading</p>}>
        <PendingBoundary id={id} />
      </Suspense>
    </main>
  );
}
