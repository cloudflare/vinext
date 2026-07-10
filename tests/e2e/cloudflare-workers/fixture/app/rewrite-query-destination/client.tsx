"use client";

import { useSearchParams } from "next/navigation";

export default function VisibleRewriteQuery() {
  const searchParams = useSearchParams();
  return <p data-testid="worker-rewrite-client">client:{searchParams.toString()}</p>;
}
