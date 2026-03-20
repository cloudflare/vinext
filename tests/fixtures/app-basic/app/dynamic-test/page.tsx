// Route segment config: force-dynamic means this page is always SSR'd, never cached
export const dynamic = "force-dynamic";

export default function DynamicTestPage() {
  const timestamp = Date.now();
  return (
    <div data-testid="dynamic-test-page">
      <h1>Force Dynamic Page</h1>
      <p>
        Rendered at: <span data-testid="timestamp">{timestamp}</span>
      </p>
    </div>
  );
}
