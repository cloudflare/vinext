import { Suspense } from "react";
import { appendRenderResponseHeader } from "../../lib/render-response-header";

export const revalidate = 1;

async function LateRenderHeaders() {
  await new Promise((resolve) => setTimeout(resolve, 120));
  appendRenderResponseHeader("x-rendered-late", "yes");
  appendRenderResponseHeader("Set-Cookie", "rendered-late=1; Path=/; HttpOnly");
  return <p data-testid="rendered-late-header">RenderedLateHeader: yes</p>;
}

export default function CachedRenderHeadersPage() {
  appendRenderResponseHeader("x-rendered-in-page", "yes");
  appendRenderResponseHeader("x-mw-conflict", "page");
  appendRenderResponseHeader("Vary", "x-render-one");
  appendRenderResponseHeader("Vary", "x-render-two");
  appendRenderResponseHeader("WWW-Authenticate", 'Basic realm="render"');
  appendRenderResponseHeader("WWW-Authenticate", 'Bearer realm="render"');
  appendRenderResponseHeader("Set-Cookie", "rendered=1; Path=/; HttpOnly");
  appendRenderResponseHeader("Set-Cookie", "rendered-second=1; Path=/; HttpOnly");

  return (
    <main>
      <h1>Cached Render Headers</h1>
      <p data-testid="rendered-header">RenderedHeader: yes</p>
      <Suspense
        fallback={<p data-testid="rendered-late-header-fallback">RenderedLateHeader: loading</p>}
      >
        <LateRenderHeaders />
      </Suspense>
    </main>
  );
}
