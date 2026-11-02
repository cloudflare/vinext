"use client";

import "./layout-panel.css";

if (typeof window === "undefined") {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

export function LayoutPanel() {
  return (
    <p className="layout-panel" data-testid="layout-panel">
      layout panel
    </p>
  );
}
