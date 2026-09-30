"use client";

import { use } from "react";

type HoldWindow = Window & {
  __commitRaceLayoutHold?: Promise<string>;
  __commitRaceLayoutRelease?: (value: string) => void;
};

export function LayoutHold({ mode }: { mode: "hold" | "ready" }) {
  if (mode === "ready") {
    return <p data-testid="layout-hold">ready</p>;
  }

  return <LayoutHoldPending />;
}

function LayoutHoldPending() {
  const holdWindow = window as HoldWindow;
  if (holdWindow.__commitRaceLayoutHold === undefined) {
    holdWindow.__commitRaceLayoutHold = new Promise((resolve) => {
      holdWindow.__commitRaceLayoutRelease = resolve;
    });
  }

  const value = use(holdWindow.__commitRaceLayoutHold);
  return <p data-testid="layout-hold">{value}</p>;
}
