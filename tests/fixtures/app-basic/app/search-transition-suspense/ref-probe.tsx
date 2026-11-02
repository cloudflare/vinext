"use client";

import { useCallback } from "react";

// Counts ref attachments, like a component that keys one-time work on a ref.
export function RefProbe() {
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      const root = document.documentElement;
      root.dataset.searchTransitionRefAttachments = String(
        Number(root.dataset.searchTransitionRefAttachments ?? 0) + 1,
      );
    }
  }, []);

  return <div data-testid="search-transition-ref-probe" ref={ref} />;
}
