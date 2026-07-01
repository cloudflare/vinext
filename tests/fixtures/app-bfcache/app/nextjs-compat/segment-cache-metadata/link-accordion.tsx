"use client";

import Link, { type LinkProps } from "next/link";
import { useState } from "react";

export function LinkAccordion({
  href,
  children,
  prefetch,
}: {
  children: string;
  href: string;
  prefetch?: LinkProps["prefetch"];
}) {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <>
      <input
        data-link-accordion={href}
        type="checkbox"
        checked={isVisible}
        onChange={() => setIsVisible(!isVisible)}
      />
      {isVisible ? (
        <Link href={href} prefetch={prefetch}>
          {children}
        </Link>
      ) : (
        `${children} (link is hidden)`
      )}
    </>
  );
}
