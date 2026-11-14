"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { redirectToPagesRoute, redirectToTarget, revalidateStart } from "./actions";

export function RefreshButton() {
  const router = useRouter();
  return (
    <button type="button" id="refresh-button" onClick={() => router.refresh()}>
      Refresh
    </button>
  );
}

/** Once a test arms it, replaces the URL on mount, as a page normalizing its URL would. */
export function ReplaceOnMount() {
  const router = useRouter();
  useEffect(() => {
    const href = Reflect.get(window, "__replaceOnMount");
    if (typeof href !== "string") return;
    Reflect.deleteProperty(window, "__replaceOnMount");
    router.replace(href);
  }, [router]);
  return null;
}

export function PushAndRefreshButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      id="push-and-refresh-button"
      onClick={() => {
        router.push("/refresh-during-navigation/destination");
        router.refresh();
      }}
    >
      Push and refresh
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

export function PagesRedirectActionButton() {
  return (
    <button type="button" id="pages-redirect-action-button" onClick={() => redirectToPagesRoute()}>
      Pages redirect action
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
