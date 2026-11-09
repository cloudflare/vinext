"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

// Links to the same-origin absolute URL for `?path=`, as an app does after
// checking a URL with `new URL(href).origin === location.origin`.
export default function SameOriginHrefPage() {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    const path = new URLSearchParams(window.location.search).get("path") ?? "/";
    setHref(window.location.origin + path);
  }, []);
  return href ? (
    <Link id="same-origin-link" href={href}>
      same-origin link
    </Link>
  ) : null;
}
