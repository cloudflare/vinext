"use client";

// Ported from Next.js:
// test/e2e/app-dir/segment-cache/max-prefetch-inlining/components/link-accordion.tsx
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/segment-cache/max-prefetch-inlining/components/link-accordion.tsx
import Link, { type LinkProps } from "next/link";
import { useState } from "react";

export function LinkAccordion({
  href,
  children,
  id,
}: {
  href: LinkProps["href"];
  children: React.ReactNode;
  id?: string;
}) {
  const [isVisible, setIsVisible] = useState(false);
  return (
    <>
      <input
        type="checkbox"
        checked={isVisible}
        onChange={() => setIsVisible(!isVisible)}
        data-link-accordion={id ?? href}
      />
      {isVisible ? <Link href={href}>{children}</Link> : `${children} (link is hidden)`}
    </>
  );
}
