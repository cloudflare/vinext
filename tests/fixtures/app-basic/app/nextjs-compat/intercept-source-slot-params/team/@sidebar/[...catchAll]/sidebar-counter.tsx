"use client";

import { useState } from "react";

export function SidebarCounter() {
  const [count, setCount] = useState(0);
  return (
    <button id="intercept-source-slot-params-sidebar-count" onClick={() => setCount(count + 1)}>
      Sidebar count: {count}
    </button>
  );
}
