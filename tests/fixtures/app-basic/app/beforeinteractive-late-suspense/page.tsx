import { randomUUID } from "node:crypto";
import { Suspense } from "react";
import { LateBeforeInteractive } from "./script";

export default function BeforeInteractiveLateSuspensePage(): React.ReactElement {
  return (
    <main>
      <h1>Late Before Interactive Suspense</h1>
      <Suspense fallback={<p data-testid="late-script-fallback">Loading late script</p>}>
        <LateBeforeInteractive delayKey={randomUUID()} />
      </Suspense>
    </main>
  );
}
