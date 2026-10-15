"use client";

import { useRouter } from "next/navigation";
import { redirectToTarget, revalidateStart } from "./actions";

export function RefreshButton() {
  const router = useRouter();
  return (
    <button type="button" id="refresh-button" onClick={() => router.refresh()}>
      Refresh
    </button>
  );
}

export function ExternalPushButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      id="external-push-button"
      onClick={() => router.push("https://external.example/")}
    >
      External
    </button>
  );
}

export function RedirectActionButton() {
  return (
    <button type="button" id="redirect-action-button" onClick={() => redirectToTarget()}>
      Redirect action
    </button>
  );
}

export function RevalidateActionButton() {
  return (
    <button type="button" id="revalidate-action-button" onClick={() => revalidateStart()}>
      Revalidate action
    </button>
  );
}
