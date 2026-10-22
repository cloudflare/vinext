import { Suspense } from "react";
import { Slow } from "./slow";
import { Fast } from "./fast";

export const dynamic = "force-dynamic";

export default function CssGroupSlowFirst() {
  return (
    <main>
      <Suspense fallback={<p data-testid="css-group-fallback">loading</p>}>
        <Slow />
      </Suspense>
      <Fast />
    </main>
  );
}
