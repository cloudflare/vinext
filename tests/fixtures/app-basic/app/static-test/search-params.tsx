"use client";

import { useSearchParams } from "next/navigation";

export default function ForceStaticSearchParams() {
  return <p data-testid="force-static-search-params">{useSearchParams().get("value") ?? "N/A"}</p>;
}
