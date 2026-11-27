// Used by tests/app-router-metadata-routes.test.ts: a generated icon whose
// image ids sit at /metadata-static-sibling/icon/<id>. The exact nested route
// icon/icon.tsx must still serve /metadata-static-sibling/icon/icon.
export function generateImageMetadata() {
  return [{ id: "small", size: { width: 16, height: 16 } }];
}

export default async function Icon({ id }: { id: Promise<string> }) {
  return new Response(`generated ${await id}`, { headers: { "content-type": "text/plain" } });
}
