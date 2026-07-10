"use client";

import { useSearchParams } from "next/navigation";

export default function QueryEcho() {
  const searchParams = useSearchParams();
  return <p data-testid="worker-query">worker query:{searchParams.get("q") ?? "none"}</p>;
}
