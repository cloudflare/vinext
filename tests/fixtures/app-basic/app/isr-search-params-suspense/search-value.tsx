"use client";

import { useSearchParams } from "next/navigation";

export default function SearchValue() {
  return <p data-testid="search-value">{useSearchParams().get("value") ?? "none"}</p>;
}
