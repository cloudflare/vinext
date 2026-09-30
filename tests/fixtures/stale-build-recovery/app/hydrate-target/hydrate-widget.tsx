"use client";

import { useState } from "react";
import { VERSION } from "../version";

export function HydrateWidget() {
  const [count, setCount] = useState(0);

  return (
    <button id="widget" onClick={() => setCount(count + 1)} type="button">
      HYDRATE_WIDGET_MARKER {VERSION} {count}
    </button>
  );
}
