"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export function PrewarmControls({ mode }: { mode: string }) {
  const router = useRouter();

  if (mode === "router") {
    return (
      <>
        <button
          data-testid="router-prefetch"
          type="button"
          onClick={() => router.prefetch("/prewarm-target")}
        >
          Prefetch /prewarm-target
        </button>
        <button
          data-testid="router-navigate"
          type="button"
          onClick={() => router.push("/prewarm-target")}
        >
          Navigate to /prewarm-target
        </button>
      </>
    );
  }

  if (mode === "soft") {
    return (
      <Link data-testid="soft-navigation" href="/prewarm-target" prefetch={false}>
        Navigate without prefetch
      </Link>
    );
  }

  if (mode === "dynamic") {
    return (
      <Link data-testid="dynamic-prefetch" href="/dynamic" prefetch>
        Prefetch dynamic route
      </Link>
    );
  }

  if (mode === "full") {
    return (
      <Link data-testid="link-prefetch" href="/prewarm-target" prefetch>
        Full-prefetch /prewarm-target
      </Link>
    );
  }

  return (
    <Link data-testid="link-prefetch" href="/prewarm-target">
      Prefetch /prewarm-target from {mode}
    </Link>
  );
}
