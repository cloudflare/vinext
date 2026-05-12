"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setFlagAction, setFlagAndRefreshAction } from "./actions";

declare global {
  interface Window {
    __VINEXT_ACTION_REFRESH_STARTED__?: boolean;
  }
}

export function ActionRefreshClient({ value }: { value: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function mutateWithActionAndRefresh() {
    const nextValue = !value;
    window.__VINEXT_ACTION_REFRESH_STARTED__ = true;
    startTransition(async () => {
      await setFlagAction(nextValue);
      router.refresh();
    });
  }

  function mutateWithServerRefresh() {
    const nextValue = !value;
    window.__VINEXT_ACTION_REFRESH_STARTED__ = true;
    startTransition(async () => {
      await setFlagAndRefreshAction(nextValue);
    });
  }

  return (
    <main>
      <h1>Action Refresh No Rerender</h1>
      <p id="flag-value">{String(value)}</p>
      <button id="action-refresh" disabled={isPending} onClick={mutateWithActionAndRefresh}>
        Action then refresh
      </button>
      <button
        id="action-refresh-from-server"
        disabled={isPending}
        onClick={mutateWithServerRefresh}
      >
        Action refresh
      </button>
    </main>
  );
}
