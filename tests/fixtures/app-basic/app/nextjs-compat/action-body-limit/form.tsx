"use client";

import { useTransition } from "react";
import { measureAction } from "./actions";

export default function ActionBodyLimitForm() {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      id="overflow-action"
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          await measureAction("a".repeat(2 * 1024 * 1024));
        });
      }}
    >
      Submit oversized action
    </button>
  );
}
