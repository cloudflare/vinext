"use client";

import Link, { type LinkProps } from "next/link";
import { useState } from "react";

export function LinkAccordion({
  children,
  href,
  prefetch,
}: {
  children: React.ReactNode;
  href: string;
  prefetch?: LinkProps["prefetch"];
}) {
  const [isVisible, setIsVisible] = useState(false);
  return (
    <>
      <input
        checked={isVisible}
        data-link-accordion={href}
        onChange={() => setIsVisible(!isVisible)}
        type="checkbox"
      />
      {isVisible ? (
        <Link href={href} prefetch={prefetch}>
          {children}
        </Link>
      ) : (
        <>{children} (link is hidden)</>
      )}
    </>
  );
}
