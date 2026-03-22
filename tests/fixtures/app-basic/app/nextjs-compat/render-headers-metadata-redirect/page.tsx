import { redirect } from "next/navigation";
import { appendRenderResponseHeader } from "../../lib/render-response-header";

export function generateMetadata() {
  appendRenderResponseHeader("x-rendered-in-metadata", "yes");
  appendRenderResponseHeader("x-mw-conflict", "metadata");
  appendRenderResponseHeader("Set-Cookie", "metadata-redirect=1; Path=/; HttpOnly");
  redirect("/about");
}

export default function RenderHeadersMetadataRedirectPage() {
  return <p>unreachable</p>;
}
