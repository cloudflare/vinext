import { loadOgFont } from "@test/og-font";
import { ImageResponse } from "next/og";

export const runtime = "edge";

export async function GET() {
  const font = await loadOgFont();

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 88,
        fontFamily: "Noto Sans",
        background: "#fff",
        color: "#000",
      }}
    >
      Linked package OG
    </div>,
    {
      width: 1200,
      height: 630,
      fonts: [{ name: "Noto Sans", data: font, style: "normal" }],
    },
  );
}
