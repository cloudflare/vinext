"use client";

import { useSearchParams } from "next/navigation";

export function ClientQuery() {
  return <p id="client-query">client query {useSearchParams().get("q") ?? "none"}</p>;
}
