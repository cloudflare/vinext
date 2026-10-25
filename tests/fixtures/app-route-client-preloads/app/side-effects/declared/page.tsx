import { Suspense } from "react";
import { Label } from "./label";

export const dynamic = "force-dynamic";

export default function SideEffects() {
  return (
    <main>
      <Suspense fallback={<p data-testid="side-effects-fallback">loading</p>}>
        <Label />
      </Suspense>
    </main>
  );
}
