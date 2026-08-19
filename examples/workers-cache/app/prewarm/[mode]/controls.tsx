"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export function PrewarmControls({ mode }: { mode: string }) {
  const router = useRouter();

  if (mode === "router") {
    return (
      <button
        data-testid="router-prefetch"
        type="button"
        onClick={() => router.prefetch("/cached/intro")}
      >
        Prefetch /cached/intro
      </button>
    );
  }

  if (mode === "soft") {
    return (
      <Link data-testid="soft-navigation" href="/cached/intro" prefetch={false}>
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

  return (
    <Link data-testid="link-prefetch" href="/cached/intro" prefetch>
      Prefetch /cached/intro from {mode}
    </Link>
  );
}
