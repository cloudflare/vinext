"use client";

import { useRouter } from "next/navigation";

export function ClientCacheControls() {
  const router = useRouter();

  return (
    <button id="client-cache-invalidate" type="button" onClick={() => router.refresh()}>
      Invalidate client cache
    </button>
  );
}
