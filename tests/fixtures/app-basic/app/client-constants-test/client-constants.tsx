"use client";

import { useState } from "react";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

export function ClientConstants() {
  const [clicks, setClicks] = useState(0);

  return (
    <button data-testid="client-constants" onClick={() => setClicks((value) => value + 1)}>
      {PHASE_PRODUCTION_BUILD}:{clicks}
    </button>
  );
}
