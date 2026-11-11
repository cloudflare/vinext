"use client";

import Link from "next/link";
import { useState } from "react";

export function RevealLink({ id }: { id: string }) {
  const [isRevealed, setIsRevealed] = useState(id === "a");
  return isRevealed ? (
    <Link id={`link-${id}`} href={`/search-prefetch/target?q=${id}`}>
      {id}
    </Link>
  ) : (
    <button id={`reveal-${id}`} type="button" onClick={() => setIsRevealed(true)}>
      reveal {id}
    </button>
  );
}
