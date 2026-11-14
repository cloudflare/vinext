import { Suspense } from "react";
import { SuspensePanel } from "./panel";

export const dynamic = "force-dynamic";

async function Slow() {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return <SuspensePanel />;
}

export default function LateSuspensePage() {
  return (
    <Suspense fallback={<p data-testid="late-suspense-fallback">loading</p>}>
      <Slow />
    </Suspense>
  );
}
