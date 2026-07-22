"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function RefreshPendingClient() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <div>
      <p id="refresh-pending-state">{isPending ? "pending" : "idle"}</p>
      <button
        id="refresh-current-route"
        onClick={() => {
          startTransition(() => {
            router.refresh();
          });
        }}
      >
        Refresh current route
      </button>
    </div>
  );
}
