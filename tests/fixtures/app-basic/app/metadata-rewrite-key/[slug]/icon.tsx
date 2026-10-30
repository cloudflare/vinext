// Used by E2E: app-router/isr.spec.ts — the /metadata-rewrite-icon/:slug/:id
// config rewrite renders the decoded image id, like a direct request.
export async function generateImageMetadata() {
  return [{ contentType: "text/plain", id: "small" }];
}

export default async function Icon({
  id,
  params,
}: {
  id: Promise<string>;
  params: Promise<{ slug: string }>;
}) {
  const [{ slug }, imageId] = await Promise.all([params, id]);
  return new Response(`icon ${slug} ${imageId}`, { headers: { "content-type": "text/plain" } });
}
