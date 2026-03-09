import { headers } from "next/headers";

/**
 * Test fixture for the "Do NOT clear context here" regression.
 *
 * This layout reads headers() asynchronously — simulating what
 * NextIntlClientProviderServer does during lazy RSC stream consumption.
 *
 * When renderHTTPAccessFallbackPage() (or renderErrorBoundaryPage()) had the
 * early-clear bug, setHeadersContext(null) was called immediately after
 * renderToReadableStream() returned. The ALS store's headersContext field was
 * wiped before this layout's async body ran during stream consumption, causing
 * headers() to throw or return null.
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const requestId = h.get("x-rsc-context-test") ?? "missing";

  return (
    <div id="rsc-context-layout" data-request-id={requestId}>
      {children}
    </div>
  );
}
