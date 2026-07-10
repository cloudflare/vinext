"use client";

import { useSearchParams } from "next/navigation";

export default function VisibleRewriteQuery() {
  const searchParams = useSearchParams();
  return <p data-testid="rewrite-client-query">client:{searchParams.toString()}</p>;
}
