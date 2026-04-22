"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

export function PendingClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filter = searchParams.get("filter") ?? "none";
  const [isPending, startTransition] = useTransition();

  return (
    <div>
      <p id="pending-state">{isPending ? "pending" : "idle"}</p>
      <p id="client-filter">client filter: {filter}</p>
      <button
        id="push-alpha"
        onClick={() => {
          startTransition(() => {
            router.push("?filter=alpha");
          });
        }}
      >
        Push alpha
      </button>
    </div>
  );
}
