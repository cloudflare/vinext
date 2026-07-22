"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export function StatefulClientComponent({ n }: { n: string }) {
  const [count, setCount] = useState(0);
  const searchParams = useSearchParams();
  const { bfcacheId } = useRouter();

  return (
    <div>
      <div>
        <button id={`increment-button-${n}`} onClick={() => setCount((value) => value + 1)}>
          Increment
        </button>
        <span id={`counter-display-${n}`}>Count: {count}</span>
        <span data-testid="leaf-bfcache-id">{bfcacheId}</span>
      </div>
      <div>
        <input id={`uncontrolled-input-${n}`} type="text" />
      </div>
      {/* Reserved for the upstream search-param BFCache case, not yet ported. */}
      <div id={`has-search-param-${n}`}>
        Has search param: {searchParams.get("param") ? "yes" : "no"}
      </div>
    </div>
  );
}
