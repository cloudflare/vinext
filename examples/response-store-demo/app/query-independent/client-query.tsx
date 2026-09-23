"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

function CurrentQuery() {
  return <output data-testid="query-independent-client-value">{useSearchParams().get("q")}</output>;
}

export default function ClientQueryAfterHydration() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <CurrentQuery /> : null;
}
