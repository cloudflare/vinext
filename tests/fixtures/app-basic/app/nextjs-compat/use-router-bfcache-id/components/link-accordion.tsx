"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

export function LinkAccordion({ children, href }: { children: ReactNode; href: string }) {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <>
      <input
        data-link-accordion={href}
        checked={isVisible}
        onChange={() => setIsVisible((value) => !value)}
        type="checkbox"
      />
      {isVisible ? <Link href={href}>{children}</Link> : `${children} (link is hidden)`}
    </>
  );
}
