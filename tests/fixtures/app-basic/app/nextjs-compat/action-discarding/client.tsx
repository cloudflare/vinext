"use client";

import { slowAction, slowActionWithRefresh } from "./actions";

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
