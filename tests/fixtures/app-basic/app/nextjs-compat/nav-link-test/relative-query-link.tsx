"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

export function RelativeQueryLink() {
  const searchParams = useSearchParams();
  const page = searchParams.get("page") ?? "1";

  useEffect(() => {
    (window as any).__APP_RELATIVE_QUERY_LINK_READY__ = true;
    return () => {
      delete (window as any).__APP_RELATIVE_QUERY_LINK_READY__;
    };
  }, []);

  return (
    <div>
      <Link
        href="?page=2"
        id="link-relative-query"
        onNavigate={(event) => {
          const navEvent = event as typeof event & { url: URL };
          (window as any).__APP_RELATIVE_ONNAV_URL__ =
            navEvent.url.pathname + navEvent.url.search + navEvent.url.hash;
        }}
      >
        Go to page 2 via relative query
      </Link>
      <p id="relative-query-page">Current page param: {page}</p>
    </div>
  );
}
