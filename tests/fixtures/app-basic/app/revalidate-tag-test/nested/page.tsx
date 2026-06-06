/**
 * Nested page under revalidate-tag-test that shares the same tag.
 *
 * Tests: ON-2 in TRACKING.md — verifies tag invalidation propagates to nested pages.
 */

export const revalidate = 3600;

async function getTaggedData() {
  // Use a tagged fetch to demonstrate revalidateTag behavior without depending
  // on external network availability in CI.
  await fetch("data:application/json,%7B%22ok%22%3Atrue%7D", {
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
