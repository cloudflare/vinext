"use client";

import { useState, type ComponentType } from "react";

export default function OnDemandStylesheetPage() {
  const [Panel, setPanel] = useState<ComponentType | null>(null);
  return (
    <>
      <button
        id="open-panel"
        type="button"
        onClick={() => {
          void import("./panel").then((mod) => setPanel(() => mod.default));
        }}
      >
        Open panel
      </button>
      {Panel ? <Panel /> : null}
    </>
  );
}
