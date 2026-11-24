"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

const RECORD = "/nextjs-compat/client-cache-required-search/record";

export function RequiredSearchLinks() {
  const router = useRouter();
  return (
    <>
      <Link href={`${RECORD}?item=from-link`} id="required-search-link">
        Link record
      </Link>
      <button
        id="required-search-prefetch"
        onClick={() => router.prefetch(`${RECORD}?item=from-router`)}
      >
        Prefetch record
      </button>
      <button id="required-search-push" onClick={() => router.push(`${RECORD}?item=from-router`)}>
        Push record
      </button>
    </>
  );
}
