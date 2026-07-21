"use client";

import Link from "next/link";

export default function ClientComponent() {
  return (
    <div>
      On client
      <Link href="/nextjs-compat/prefetch-false-loading/en/testing" prefetch={false}>
        To /en/testing
      </Link>
    </div>
  );
}
