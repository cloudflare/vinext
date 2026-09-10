import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };

export default function OpenGraphImage() {
  return new ImageResponse(
    <div style={{ display: "flex", width: "100%", height: "100%" }}>static metadata image</div>,
    size,
  );
}
