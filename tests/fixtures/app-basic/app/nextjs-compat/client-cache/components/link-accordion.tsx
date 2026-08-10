"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useState } from "react";

export function LinkAccordion({
  children,
  href,
  prefetch,
}: {
  children: ReactNode;
  href: string;
  prefetch?: boolean;
}) {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <>
      <input
        checked={isVisible}
        data-link-accordion={href}
        onChange={() => setIsVisible((value) => !value)}
        type="checkbox"
      />
      {isVisible ? (
        <Link data-link-accordion-anchor={href} href={href} prefetch={prefetch}>
          {children}
        </Link>
      ) : (
        <>{children} (link is hidden)</>
      )}
    </>
  );
}
