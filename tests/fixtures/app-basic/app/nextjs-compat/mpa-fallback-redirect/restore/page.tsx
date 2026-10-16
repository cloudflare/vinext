"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

const TARGET = "/nextjs-compat/mpa-fallback-redirect/login";

export default function RestorePage() {
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [pushed, setPushed] = useState(false);
  const [isPending, startTransition] = useTransition();
  return (
    <div>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Trigger re-render
      </button>
      <p id="mpa-restore-count">{count}</p>
      <Link href={TARGET} prefetch={false}>
        Login
      </Link>
      <button
        type="button"
        onClick={() => {
          startTransition(() => {
            setPushed(true);
            router.push(TARGET);
          });
        }}
      >
        Push in transition
      </button>
      <p id="mpa-restore-pending">{String(isPending)}</p>
      <p id="mpa-restore-pushed">{String(pushed)}</p>
    </div>
  );
}
