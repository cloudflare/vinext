import { notFound } from "next/navigation";

/**
 * This page always calls notFound(), triggering renderHTTPAccessFallbackPage()
 * with the ancestor layout (layout.tsx) in scope.
 *
 * On RSC requests (Accept: text/x-component), renderHTTPAccessFallbackPage()
 * calls renderToReadableStream() and returns the stream immediately. The bug
 * was that setHeadersContext(null) / setNavigationContext(null) was called
 * right after — before the stream was consumed. The layout's async headers()
 * call runs during lazy stream consumption and would see null context.
 */
export default function Page() {
  notFound();
}
