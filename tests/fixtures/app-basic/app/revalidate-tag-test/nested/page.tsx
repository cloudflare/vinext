/**
 * Nested page under revalidate-tag-test that shares the same tag.
 *
 * Tests: ON-2 in TRACKING.md — verifies tag invalidation propagates to nested pages.
 */

export const revalidate = 3600;

async function getTaggedData() {
  await fetch("https://httpbin.org/uuid", {
    next: { tags: ["test-data"] },
  });
  const timestamp = Date.now();
  return { timestamp };
}

export default async function NestedRevalidateTagPage() {
  const data = await getTaggedData();

  return (
    <div data-testid="revalidate-tag-nested-page">
      <h1>Nested Revalidate Tag Test</h1>
      <p data-testid="timestamp">Fetched time: {data.timestamp}</p>
    </div>
  );
}
