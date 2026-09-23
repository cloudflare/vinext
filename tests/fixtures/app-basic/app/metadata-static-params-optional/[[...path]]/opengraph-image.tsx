export const dynamicParams = false;

export function generateStaticParams() {
  return [{ path: undefined }];
}

export default async function OpenGraphImage({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  return new Response(path ? path.join("/") : "EMPTY OPTIONAL", {
    headers: { "content-type": "text/plain" },
  });
}
