// Returns a plain Response to avoid Satori/Resvg dependencies in tests.
export const contentType = "image/png";

export default async function ClipImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return new Response(`clip:${id}`, {
    headers: { "Content-Type": "image/png" },
  });
}
