"use client";

import { startTransition, useEffect, useState } from "react";

// Lives in the layout, so its state survives the page's search navigations.
// The test starts its Transition through `window.__vtAppTransition` while a
// view transition is in progress.
export function AppTransitionButton() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const w = window as unknown as { __vtAppTransition?: () => void };
    w.__vtAppTransition = () => startTransition(() => setCount((current) => current + 1));
    return () => {
      delete w.__vtAppTransition;
    };
  }, []);
  return <p data-testid="app-transition">app transitions: {count}</p>;
}
