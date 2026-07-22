// Fixture for classifyAppRoute integration test: revalidate=Infinity → static.
// Next.js treats revalidate=Infinity as "never revalidate" (fully static).
// Also used by app-router.test.ts to assert ISR cache stability across
// requests when the page declares an indefinite cache policy.
export const revalidate = Infinity;

export default function RevalidateInfinityPage() {
  const timestamp = Date.now();
  return (
    <div data-testid="revalidate-infinity-test-page">
      <p>revalidate-infinity</p>
      <span data-testid="timestamp">{timestamp}</span>
    </div>
  );
}
