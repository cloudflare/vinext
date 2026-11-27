"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export function Nav({ to }: { to: string }) {
  const router = useRouter();
  return (
    <div>
      <Link href={to} transitionTypes={["nav-forward"]} data-testid="typed-link">
        typed link
      </Link>
      <Link href={to} data-testid="untyped-link">
        untyped link
      </Link>
      <button
        data-testid="typed-push"
        onClick={() => router.push(to, { transitionTypes: ["nav-push"] })}
      >
        typed push
      </button>
      <button
        data-testid="typed-replace"
        onClick={() => router.replace(to, { transitionTypes: ["nav-replace"] })}
      >
        typed replace
      </button>
    </div>
  );
}
