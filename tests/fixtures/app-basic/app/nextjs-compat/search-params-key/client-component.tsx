"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ClientComponent() {
  const [count, setCount] = useState(0);
  const router = useRouter();

  return (
    <div>
      <div id="count">{count}</div>
      <button id="increment" onClick={() => setCount((c) => c + 1)}>
        Increment
      </button>
      <button id="push-foo-bar" onClick={() => router.push("?foo=bar")}>
        Push foo=bar
      </button>
      <button id="replace-foo-baz" onClick={() => router.replace("?foo=baz")}>
        Replace foo=baz
      </button>
    </div>
  );
}
