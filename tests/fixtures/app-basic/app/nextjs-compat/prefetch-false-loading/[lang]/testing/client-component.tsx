"use client";

import Link from "next/link";

export default function ClientComponent() {
  return (
    <div>
      On client
      <Link href="/nextjs-compat/prefetch-false-loading/en/testing/test" prefetch={false}>
        To /en/testing/test
      </Link>
    </div>
  );
}
