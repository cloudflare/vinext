import { ImageResponse } from "next/og";

export const revalidate = 2;
export default async function Image() {
  const renderId = crypto.randomUUID();
  return new ImageResponse(<div style={{ display: "flex", background: "white" }}>{renderId}</div>, {
    width: 600,
    height: 80,
    headers: {
      "Cache-Control": "public, max-age=3600",
      "X-Render-Id": renderId,
    },
  });
}
