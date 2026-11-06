"use client";

import { useLayoutEffect } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Writes a shallow URL from a layout effect while the navigation to this page
 * is committing. Next.js has already written the destination URL by then, so
 * the relative write lands on this page's entry.
 */
export default function ShallowOnMountPage() {
  const searchParams = useSearchParams();

  useLayoutEffect(() => {
    if (!new URLSearchParams(window.location.search).has("x")) {
      window.history.replaceState(null, "", "?x=1");
    }
  }, []);

  return <p data-testid="on-mount-search">search: {searchParams.toString()}</p>;
}
