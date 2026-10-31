"use client";

import "./panel.css";

export function SuspensePanel() {
  return (
    <p className="late-suspense-panel" data-testid="late-suspense-panel">
      loaded
    </p>
  );
}
