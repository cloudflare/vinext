/**
 * ISR page with tagged fetch for revalidateTag testing.
 *
 * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/open-next/app/revalidate-tag/
 * Tests: ON-2 in TRACKING.md
 */

export const revalidate = 3600; // Long TTL — only invalidated by revalidateTag

async function getTaggedData() {
  // Use a tagged fetch to demonstrate revalidateTag behavior
  await fetch("https://httpbin.org/uuid", {
    next: { tags: ["test-data"] },
  });
  // If fetch fails or is unavailable, use local timestamp
  const timestamp = Date.now();
  return { timestamp };
}

export default async function RevalidateTagTestPage() {
  const data = await getTaggedData();

  return (
    <div data-testid="revalidate-tag-test-page">
      <h1>Revalidate Tag Test</h1>
      <p data-testid="timestamp">Fetched time: {data.timestamp}</p>
      <p data-testid="request-id">RequestID: {Math.random().toString(36).slice(2)}</p>
    </div>
  );
}
