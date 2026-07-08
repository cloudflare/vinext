import { ImageResponse } from "next/og";

export const config = {
  runtime: "edge",
};

export default function handler() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "lavender",
        display: "flex",
        fontSize: 96,
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      Hello!
    </div>,
  );
}
