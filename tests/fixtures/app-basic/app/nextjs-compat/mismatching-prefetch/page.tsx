"use client";

import Link from "next/link";
import { useState } from "react";

const href = "/nextjs-compat/mismatching-prefetch/dynamic-page/a?mismatch-rewrite=./b";

export default function Page() {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <main>
      <button id="reveal-mismatching-prefetch" onClick={() => setIsVisible(true)}>
        Reveal link
      </button>
      {isVisible ? (
        <Link id="mismatching-prefetch-link" href={href}>
          Navigate to prefetched route A
        </Link>
      ) : null}
    </main>
  );
}
