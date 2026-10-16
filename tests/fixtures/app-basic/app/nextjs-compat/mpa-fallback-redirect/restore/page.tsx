"use client";

import Link from "next/link";
import { useState } from "react";

export default function RestorePage() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Trigger re-render
      </button>
      <p id="mpa-restore-count">{count}</p>
      <Link href="/nextjs-compat/mpa-fallback-redirect/login" prefetch={false}>
        Login
      </Link>
    </div>
  );
}
