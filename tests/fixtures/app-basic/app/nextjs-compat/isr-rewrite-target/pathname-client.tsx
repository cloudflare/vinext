"use client";

import { usePathname } from "next/navigation";

export function PathnameClient() {
  const pathname = usePathname();

  return <p id="current-pathname">{pathname}</p>;
}
