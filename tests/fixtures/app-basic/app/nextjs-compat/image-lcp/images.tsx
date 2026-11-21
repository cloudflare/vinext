"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

export default function Images({ mode }: { mode: string }) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const heroProps =
    mode === "preload"
      ? { preload: true }
      : mode === "priority"
        ? { priority: true }
        : { loading: mode === "eager" ? ("eager" as const) : ("lazy" as const) };
  return (
    <div id="images" data-hydrated={hydrated}>
      <Image
        id="hero"
        src="/lcp-image.jpg"
        alt="Hero"
        width={600}
        height={600}
        {...heroProps}
      />
      <div style={{ height: "300vh" }} />
      <Image
        id="duplicate"
        src="/lcp-image.jpg"
        alt="Duplicate"
        width={600}
        height={600}
        loading={mode === "lazy" ? "eager" : "lazy"}
      />
    </div>
  );
}
