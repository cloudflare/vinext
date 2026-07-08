"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export default function Page() {
  const router = useRouter();
  return (
    <>
      <Link href="/searchparams-reuse-loading?id=1" prefetch>
        Prefetch with query
      </Link>
      <button onClick={() => router.push("/searchparams-reuse-loading")}>
        Navigate without query
      </button>
    </>
  );
}
