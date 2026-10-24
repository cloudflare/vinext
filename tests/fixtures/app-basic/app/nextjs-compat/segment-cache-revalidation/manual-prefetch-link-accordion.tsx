"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

// Ported from Next.js:
// test/e2e/app-dir/segment-cache/revalidation/components/link-accordion.tsx
export function ManualPrefetchLinkAccordion({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const [isVisible, setIsVisible] = useState(false);
  return (
    <>
      <input
        type="checkbox"
        checked={isVisible}
        onChange={() => setIsVisible(!isVisible)}
        data-manual-prefetch-link-accordion={href}
      />
      {isVisible ? (
        <ManualPrefetchLink href={href}>{children}</ManualPrefetchLink>
      ) : (
        <>{children} (link is hidden)</>
      )}
    </>
  );
}

function ManualPrefetchLink({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();
  useEffect(() => {
    // For as long as the link is mounted, prefetch again whenever the cached
    // response is invalidated.
    let didUnmount = false;
    const pollPrefetch = () => {
      if (!didUnmount) router.prefetch(href, { onInvalidate: pollPrefetch });
    };
    pollPrefetch();
    return () => {
      didUnmount = true;
    };
  }, [href, router]);
  return (
    <a
      data-manual-prefetch-link={href}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        router.push(href);
      }}
    >
      {children}
    </a>
  );
}
