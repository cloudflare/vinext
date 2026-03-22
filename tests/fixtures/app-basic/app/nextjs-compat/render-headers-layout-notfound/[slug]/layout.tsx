import { notFound } from "next/navigation";
import { appendRenderResponseHeader } from "../../../lib/render-response-header";

export default function RenderHeadersLayoutNotFoundLayout({ children, params }) {
  appendRenderResponseHeader("x-layout-notfound", "yes");
  appendRenderResponseHeader("x-mw-conflict", "layout");
  appendRenderResponseHeader("Set-Cookie", "layout-notfound=1; Path=/; HttpOnly");
  if (params.slug === "missing") {
    notFound();
  }
  return <section data-testid="render-headers-layout">{children}</section>;
}
