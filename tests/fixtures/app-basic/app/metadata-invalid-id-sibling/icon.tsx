import { ImageResponse } from "next/og";

export function generateImageMetadata() {
  return [
    {
      id: "bad/id",
      size: { width: 48, height: 48 },
    },
    {
      id: "good",
      size: { width: 48, height: 48 },
    },
  ];
}

export default async function Icon({ id }: { id: Promise<string> }) {
  const imageId = await id;

  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        backgroundColor: "#101828",
        color: "#f8fafc",
        display: "flex",
        fontSize: 44,
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      {imageId}
    </div>,
    { width: 120, height: 120 },
  );
}
