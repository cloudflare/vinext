"use client";

import { revalidatingRedirect, slowAction, slowActionWithRefresh } from "./actions";

export function ActionDiscardingClient() {
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
