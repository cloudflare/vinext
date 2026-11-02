"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

// Rendered only after hydration, so the URL comes from the client bundle's
// loader rather than the server-rendered HTML.
export function ClientImage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <Image
      id="client-quality-90"
      alt="client"
      src="/get-image-props-light.png"
      width={64}
      height={64}
      quality={90}
    />
  );
}
