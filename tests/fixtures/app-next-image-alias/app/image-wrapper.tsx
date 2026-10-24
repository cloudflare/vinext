"use client";

import VinextImage from "vinext/shims/image";
import type { ComponentProps } from "react";

// The resolve.alias target for next/image. It renders vinext's stock image
// component through the explicit shim import.
export default function Image(props: ComponentProps<typeof VinextImage>) {
  return <VinextImage {...props} data-testid="aliased-image" />;
}
