"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export function SearchNav() {
  const router = useRouter();
  return (
    <div>
      <button
        data-testid="typed-search-push"
        onClick={() =>
          router.push("/view-transition-types/search?q=1", { transitionTypes: ["nav-search"] })
        }
      >
        typed search push
      </button>
      <Link href="/view-transition-types/target" data-testid="untyped-target-link">
        untyped target link
      </Link>
    </div>
  );
}
