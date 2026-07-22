import { ImageResponse } from "next/og";

export async function generateImageMetadata({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const prefix = slug.join("-");

  return [
    {
      contentType: "image/png",
      id: `${prefix}-small`,
      size: { width: 48, height: 48 },
    },
  ];
}

export default async function Icon({
  id,
  params,
}: {
  id: Promise<string>;
  params: Promise<{ slug: string[] }>;
}) {
  const [{ slug }, imageId] = await Promise.all([params, id]);

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
      {slug.join("/")}:{imageId}
    </div>,
    { width: 120, height: 120 },
  );
}
