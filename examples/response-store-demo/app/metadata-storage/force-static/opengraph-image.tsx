import { headers } from "next/headers";
import { ImageResponse } from "next/og";

export const dynamic = "force-static";
export const revalidate = 2;
export default async function Image() {
  await Promise.resolve();
  const visitor = (await headers()).get("x-visitor") ?? "anonymous";
  const renderId = crypto.randomUUID();
  return new ImageResponse(<div style={{ display: "flex", background: "white" }}>{renderId}</div>, {
    width: 600,
    height: 80,
    headers: { "Cache-Control": "private, max-age=300", "X-Render-Id": renderId, "X-Visitor": visitor },
  });
}
