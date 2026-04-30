import { ImageResponse } from "next/og";

export async function generateImageMetadata({ params }: { params: Promise<{ size: string }> }) {
  const { size } = await params;

  return [
    {
      contentType: "image/png",
      id: `${size}-small`,
      size: { width: 48, height: 48 },
    },
    {
      contentType: "image/png",
      id: `${size}-medium`,
      size: { width: 72, height: 72 },
    },
  ];
}

export default async function Icon({
  id,
  params,
}: {
  id: Promise<string>;
  params: Promise<{ size: string }>;
}) {
  const [{ size }, imageId] = await Promise.all([params, id]);

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
      {size}:{imageId}
    </div>,
    { width: 120, height: 120 },
  );
}
