"use client";

import { usePathname } from "next/navigation";

export function VisibleUrl() {
  const pathname = usePathname();

  return <p id="visible-url">{pathname}</p>;
}
