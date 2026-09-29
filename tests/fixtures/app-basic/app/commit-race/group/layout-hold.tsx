"use client";

import { use } from "react";

type HoldWindow = Window & {
  __commitRaceLayoutHold?: Promise<string>;
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
    holdWindow.__commitRaceLayoutHold = new Promise(() => {});
  }

  const value = use(holdWindow.__commitRaceLayoutHold);
  return <p data-testid="layout-hold">{value}</p>;
}
