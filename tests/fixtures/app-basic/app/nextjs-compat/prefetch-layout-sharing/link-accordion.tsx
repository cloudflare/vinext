"use client";

import Link from "next/link";
import { useState } from "react";

export function LinkAccordion({
  href,
  id,
  prefetch,
}: {
  href: string;
  id: string;
  prefetch?: boolean | "auto";
}) {
  const [visible, setVisible] = useState(false);

  return (
    <>
      <input
        aria-label={`${id} toggle`}
        data-link-accordion={href}
        id={`${id}-toggle`}
        type="checkbox"
        checked={visible}
        onChange={() => setVisible((value) => !value)}
      />
      {visible ? (
        <Link href={href} id={`${id}-link`} prefetch={prefetch}>
          {href}
        </Link>
      ) : (
        <span id={`${id}-hidden`}>{href} hidden</span>
      )}
    </>
  );
}
