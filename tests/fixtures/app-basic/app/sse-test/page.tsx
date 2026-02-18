/**
 * SSE test page (server component) for E2E streaming tests.
 *
 * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/open-next/app/sse/
 * Tests: ON-5 in TRACKING.md
 *
 * NOTE: The client logic is in sse-client.tsx (not here) because having
 * "use client" at the page level breaks SSR of dynamic() client components
 * in other routes. See: https://github.com/cloudflare/vinext/issues/75
 */
import SSEClient from "./sse-client";

export default function SSETestPage() {
  return <SSEClient />;
}
