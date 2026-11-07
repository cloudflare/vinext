"use client";

import Image from "next/image";

// A loader prop takes precedence over images.loaderFile.
export function LoaderPropImage() {
  return (
    <Image
      alt="loader-prop"
      src="/logo.png"
      width={64}
      height={64}
      priority
      loader={({ src, width, quality }) => `${src}?w=${width}&q=${quality ?? "auto"}`}
    />
  );
}
