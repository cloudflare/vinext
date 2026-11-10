"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

const target = "/nextjs-compat/prefetch-required-query/record?item=sample";

export default function Links({ mode }: { mode?: string }) {
  const router = useRouter();
  return mode === "router" ? (
    <>
      <button onClick={() => router.prefetch(target)}>Prefetch record</button>
      <button onClick={() => router.push(target)}>Open record</button>
    </>
  ) : (
    <Link href={target}>Open record</Link>
  );
}
