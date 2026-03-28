import { ImageResponse } from "next/og";

export const runtime = "edge";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const title = searchParams.get("title") ?? "vinext App Basic";

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)",
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          color: "white",
          padding: "60px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 72, fontWeight: 700, marginBottom: 24 }}>{title}</div>
        <div style={{ fontSize: 32, opacity: 0.9 }}>Open Graph Image</div>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
    },
  );
}
