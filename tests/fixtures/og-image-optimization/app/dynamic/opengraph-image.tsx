import { headers } from "next/headers";
import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };

export default async function DynamicOpenGraphImage() {
  // Request-time API — Next.js keeps metadata image routes that read request
  // data dynamic, so this route must not be statically prerendered.
  await headers();
  return new ImageResponse(
    <div style={{ display: "flex", width: "100%", height: "100%" }}>dynamic metadata image</div>,
    size,
  );
}
