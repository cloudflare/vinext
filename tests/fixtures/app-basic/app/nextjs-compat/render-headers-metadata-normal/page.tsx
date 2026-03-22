import { appendRenderResponseHeader } from "../../lib/render-response-header";

export const revalidate = 1;

export function generateMetadata() {
  appendRenderResponseHeader("x-metadata-normal", "yes");
  appendRenderResponseHeader("Set-Cookie", "metadata-normal=1; Path=/; HttpOnly");
  return { title: "metadata-normal" };
}

export default function RenderHeadersMetadataNormalPage() {
  return <p>metadata normal route</p>;
}
