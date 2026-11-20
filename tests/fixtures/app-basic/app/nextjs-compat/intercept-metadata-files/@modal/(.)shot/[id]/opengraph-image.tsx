// Returns a plain Response to avoid Satori/Resvg dependencies in tests.
export const contentType = "image/png";

export default async function ShotImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return new Response(`shot:${id}`, {
    headers: { "Content-Type": "image/png" },
  });
}
