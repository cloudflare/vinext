"use client";

import { useSearchParams } from "next/navigation";

export function SearchParamsLink() {
  const searchParams = useSearchParams();
  return (
    <a id="continue" href={searchParams.get("next") ?? "/default"}>
      Continue
    </a>
  );
}
