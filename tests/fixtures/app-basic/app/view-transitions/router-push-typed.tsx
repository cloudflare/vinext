"use client";

import { useRouter } from "next/navigation";

export function RouterPushTyped() {
  const router = useRouter();
  return (
    <button
      type="button"
      data-testid="vt-push-a-typed"
      onClick={() => router.push("/view-transitions/a", { transitionTypes: ["nav-back"] })}
    >
      push A (nav-back)
    </button>
  );
}
