import { useRef, useState } from "react";
import Image from "next/legacy/image";

// Ported from Next.js: test/e2e/next-image-legacy/default/pages/lazy-withref.js,
// lazy-src-change.js and blurry-placeholder.js
const blurDataURL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' fill='red'/%3E%3C/svg%3E";

export default function LegacyImageLazy() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState("/heart.png");
  return (
    <main>
      <Image
        id="blurry-image"
        src="/heart.png"
        width={16}
        height={16}
        priority
        placeholder="blur"
        blurDataURL={blurDataURL}
      />
      <button id="change-src" onClick={() => setSrc("/logo.svg")}>
        Change src
      </button>
      <div
        id="lazy-root"
        ref={rootRef}
        style={{ height: 200, overflowY: "scroll", position: "relative" }}
      >
        <Image
          id="near-image"
          lazyRoot={rootRef}
          lazyBoundary="400px"
          src="/heart.png"
          alt="near"
          width={16}
          height={16}
        />
        <div style={{ height: 2000 }} />
        <Image
          id="far-image"
          lazyRoot={rootRef}
          lazyBoundary="0px"
          src={src}
          alt="far"
          width={16}
          height={16}
        />
      </div>
    </main>
  );
}
