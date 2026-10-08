"use client";

import Link from "next/link";

export default function NavBar() {
  return (
    <nav>
      <Link href="/nextjs-compat/optimistic-shell-shallow/slow/1" id="slow-link">
        Slow page
      </Link>
      <Link href="/nextjs-compat/optimistic-shell-shallow/slow/2" prefetch={false} id="slow-2-link">
        Slow page 2
      </Link>
      <Link
        href="/nextjs-compat/optimistic-shell-shallow/slow/redirect"
        prefetch={false}
        id="slow-redirect-link"
      >
        Slow redirect
      </Link>
      <button
        id="enable-debug-btn"
        onClick={() => {
          const params = new URLSearchParams(window.location.search);
          params.set("debug", "1");
          window.history.pushState(null, "", `?${params}`);
        }}
      >
        Enable debug mode
      </button>
    </nav>
  );
}
