"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export default function Page() {
  const router = useRouter();
  return (
    <>
      <Link href="/searchparams-reuse-loading" prefetch>
        Prefetch without query
      </Link>
      <button onClick={() => router.push("/searchparams-reuse-loading?id=1")}>
        Navigate with query
      </button>
    </>
  );
}
