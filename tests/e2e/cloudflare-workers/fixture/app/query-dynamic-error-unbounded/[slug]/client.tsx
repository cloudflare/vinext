"use client";

import { useSearchParams } from "next/navigation";

export default function QueryEcho() {
  const searchParams = useSearchParams();
  return <p>worker unbounded query:{searchParams.get("q") ?? "none"}</p>;
}
