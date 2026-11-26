"use client";

import { useRouter } from "next/navigation";

export function RouterPushTyped() {
  const router = useRouter();
  return (
    <button
      type="button"
      data-testid="vt-push-b-typed"
      onClick={() => router.push("/view-transitions/b", { transitionTypes: ["nav-back"] })}
    >
      push B (nav-back)
    </button>
  );
}
