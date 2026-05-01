import { ImageResponse } from "next/og";

export const size = {
  width: 32,
  height: 32,
};

export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        backgroundColor: "#0070f3",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "50%",
      }}
    >
      <span style={{ fontSize: 24, color: "white" }}>N</span>
    </div>,
    { width: 32, height: 32 },
  );
}
