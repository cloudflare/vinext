import { Suspense } from "react";
import { Fast } from "./fast";
import { Slow } from "./slow";

export const dynamic = "force-dynamic";

export default function CssGroupSlowSecond() {
  return (
    <main>
      <Fast />
      <Suspense fallback={<p data-testid="css-group-fallback">loading</p>}>
        <Slow />
      </Suspense>
    </main>
  );
}
