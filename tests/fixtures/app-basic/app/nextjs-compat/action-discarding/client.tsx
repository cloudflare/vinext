"use client";

import { revalidatingRedirect, slowAction, slowActionWithRefresh } from "./actions";
import { useRouter } from "next/navigation";

export function ActionDiscardingValue({ value }: { value: number }) {
  if (typeof window !== "undefined") {
    const probe = window as typeof window & {
      __holdActionValue?: number;
      __heldActionRender?: boolean;
      __actionRenderWait?: Promise<never>;
    };
    if (probe.__holdActionValue !== undefined && value > probe.__holdActionValue) {
      probe.__heldActionRender = true;
      throw (probe.__actionRenderWait ??= new Promise<never>(() => {}));
    }
  }
  return <span id="discarded-action-value">{value}</span>;
}

export function ActionDiscardingClient() {
  const router = useRouter();
  return (
    <main>
      <h1>Action Discarding</h1>
      <button
        id="slow-action"
        onClick={async () => {
          await slowAction();
        }}
      >
        Slow action
      </button>
      <button id="revalidating-redirect" onClick={() => revalidatingRedirect()}>
        Revalidate and redirect
      </button>
      <button id="revalidating-hard-redirect" onClick={() => revalidatingRedirect("/old-school")}>
        Revalidate and redirect to Pages
      </button>
      <button
        id="revalidating-hard-redirect-and-refresh"
        onClick={async () => {
          try {
            await revalidatingRedirect("/old-school");
          } finally {
            router.refresh();
          }
        }}
      >
        Revalidate and redirect, then refresh
      </button>
      <button
        id="slow-action-refresh"
        onClick={async () => {
          await slowActionWithRefresh();
        }}
      >
        Slow action refresh
      </button>
    </main>
  );
}
