// Page-level streaming patterns. Coverage: tests/e2e/cloudflare-workers/streams-lab.spec.ts
import { Suspense } from "react";
import { StreamReader, UsePromise } from "./client";

export const dynamic = "force-dynamic";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function generateMetadata() {
  await sleep(50);
  return { description: "streams lab" };
}

// Boundaries resolve in an order unrelated to document order.
const DELAYS = [90, 10, 60, 0, 120, 30, 75, 5, 45, 100, 15, 80, 20, 55, 110, 35, 65, 25, 95, 40];

async function Delayed({ index, ms }: { index: number; ms: number }) {
  await sleep(ms);
  return <li data-testid={`boundary-${index}`}>boundary {index} after {ms}ms</li>;
}

async function Nested({ depth }: { depth: number }) {
  await sleep(5);
  if (depth === 0) return <span data-testid="nested-bottom">bottom</span>;
  return (
    <Suspense fallback={<span>nested {depth} loading</span>}>
      <Nested depth={depth - 1} />
    </Suspense>
  );
}

export default function StreamsLabPage() {
  // A ReadableStream and a promise passed to client components as props.
  const stream = new ReadableStream<string>({
    async start(controller) {
      for (const word of ["streamed", "through", "flight"]) {
        await sleep(10);
        controller.enqueue(word);
      }
      controller.close();
    },
  });
  const promise = sleep(30).then(() => "resolved through use()");

  return (
    <main>
      <h1>streams lab</h1>
      <ul>
        {DELAYS.map((ms, index) => (
          <Suspense key={index} fallback={<li>boundary {index} loading</li>}>
            <Delayed index={index} ms={ms} />
          </Suspense>
        ))}
      </ul>
      <Suspense fallback={<span>nested loading</span>}>
        <Nested depth={15} />
      </Suspense>
      <StreamReader stream={stream} />
      <Suspense fallback={<span>promise loading</span>}>
        <UsePromise promise={promise} />
      </Suspense>
    </main>
  );
}
