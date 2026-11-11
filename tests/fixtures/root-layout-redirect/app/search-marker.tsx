"use client";

import { useSearchParams } from "next/navigation";

// Shows the committed `slug` search param, so a test can tell when a
// search-only navigation has rendered while a not-found replaces the page.
export function SearchMarker() {
  return <p id="default-not-found-reset-search">{useSearchParams().get("slug") ?? ""}</p>;
}
