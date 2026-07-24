"use client";

import { useRouter } from "next/navigation";

export function ParallelRefreshButton() {
  const router = useRouter();

  return (
    <button data-testid="parallel-refresh-button" onClick={() => router.refresh()}>
      Refresh
    </button>
  );
}
