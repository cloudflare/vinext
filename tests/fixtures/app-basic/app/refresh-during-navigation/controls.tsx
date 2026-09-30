"use client";

import { startTransition } from "react";
import { useRouter } from "next/navigation";

export function RefreshDuringNavigationControls() {
  const router = useRouter();

  return (
    <>
      <button
        type="button"
        data-testid="refresh"
        onClick={() => {
          router.refresh();
        }}
      >
        Refresh
      </button>
      <button
        type="button"
        data-testid="hash-then-refresh"
        onClick={() => {
          router.push("#top", { scroll: false });
          router.refresh();
        }}
      >
        Hash then refresh
      </button>
      <button
        type="button"
        data-testid="push-then-refresh"
        onClick={() => {
          startTransition(() => {
            router.push("/refresh-during-navigation/slow");
            router.refresh();
          });
        }}
      >
        Push then refresh
      </button>
    </>
  );
}
