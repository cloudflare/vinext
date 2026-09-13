"use client";

import { useSearchParams } from "next/navigation";

export default function SearchParamsValue() {
  const searchParams = useSearchParams();
  return <p id="search-params-value">{searchParams.get("value") ?? "N/A"}</p>;
}
