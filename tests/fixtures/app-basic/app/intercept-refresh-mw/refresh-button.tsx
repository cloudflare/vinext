"use client";

import { useRouter } from "next/navigation";

export function RefreshButton() {
  const router = useRouter();
  return (
    <button id="intercept-refresh-mw-button" onClick={() => router.refresh()}>
      Refresh
    </button>
  );
}
