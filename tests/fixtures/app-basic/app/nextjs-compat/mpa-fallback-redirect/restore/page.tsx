"use client";

import Link, { useLinkStatus } from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

const TARGET = "/nextjs-compat/mpa-fallback-redirect/login";

function LinkPending() {
  const { pending } = useLinkStatus();
  return (
    <span id="mpa-restore-link-pending" aria-hidden="true">
      {String(pending)}
    </span>
  );
}

export default function RestorePage() {
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [tick, setTick] = useState(0);
  const [pushed, setPushed] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const interval = setInterval(() => setTick((value) => value + 1), 50);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Trigger re-render
      </button>
      <p id="mpa-restore-count">{count}</p>
      <p id="mpa-restore-tick">{tick}</p>
      <Link href={TARGET} prefetch={false}>
        Login
        <LinkPending />
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
      <button type="button" onClick={() => router.push("https://external.example/page")}>
        Push external
      </button>
      <p id="mpa-restore-pending">{String(isPending)}</p>
      <p id="mpa-restore-pushed">{String(pushed)}</p>
    </div>
  );
}
