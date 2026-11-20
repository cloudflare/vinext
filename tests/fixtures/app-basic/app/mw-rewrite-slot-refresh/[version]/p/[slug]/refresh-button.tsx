"use client";

import { useRouter } from "next/navigation";

export function RefreshButton() {
  const router = useRouter();
  return (
    <button id="mw-rewrite-slot-refresh-button" onClick={() => router.refresh()}>
      Refresh
    </button>
  );
}
