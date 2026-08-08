"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function AboutRefreshButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [completedRefreshes, setCompletedRefreshes] = useState(0);
  const refreshStarted = useRef(false);

  useEffect(() => {
    if (isPending || !refreshStarted.current) return;
    refreshStarted.current = false;
    setCompletedRefreshes((count) => count + 1);
  }, [isPending]);

  return (
    <>
      <button
        data-testid="about-refresh"
        onClick={() => {
          refreshStarted.current = true;
          startTransition(() => router.refresh());
        }}
      >
        Refresh About
      </button>
      <p data-testid="about-refresh-count">refreshes: {completedRefreshes}</p>
    </>
  );
}
