"use client";

import { useState } from "react";

export default function SidebarDefault() {
  const [count, setCount] = useState(0);
  return (
    <aside id="notfound-sibling-slots-sidebar">
      <p>SIDEBAR</p>
      <button
        type="button"
        id="notfound-sibling-slots-sidebar-count"
        onClick={() => setCount((value) => value + 1)}
      >
        Count: {count}
      </button>
    </aside>
  );
}
