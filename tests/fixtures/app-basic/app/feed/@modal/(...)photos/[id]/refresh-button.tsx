"use client";

import { useRouter } from "next/navigation";

export function PhotoModalRefreshButton() {
  const router = useRouter();

  return (
    <button data-testid="photo-modal-refresh" onClick={() => router.refresh()}>
      Refresh modal
    </button>
  );
}
