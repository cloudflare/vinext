import { Suspense } from "react";
import { format } from "./format";
import { Formatter } from "./formatter";

export const dynamic = "force-dynamic";

export default function ValueProp() {
  return (
    <Suspense fallback={<p data-testid="formatted-fallback">loading</p>}>
      <Formatter format={format} />
    </Suspense>
  );
}
