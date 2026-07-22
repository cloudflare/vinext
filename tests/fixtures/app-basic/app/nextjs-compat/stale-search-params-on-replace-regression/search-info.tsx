"use client";

import { useSearchParams } from "next/navigation";

export function SearchInfo() {
  const searchParams = useSearchParams();

  return <p id="search-params">{searchParams.toString()}</p>;
}
