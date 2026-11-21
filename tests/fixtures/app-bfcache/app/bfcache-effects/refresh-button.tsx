"use client";

import { useRouter } from "next/navigation";

export function RefreshButton() {
  const router = useRouter();
  return (
    <button data-testid="refresh" onClick={() => router.refresh()}>
      Refresh
    </button>
  );
}
