// Route segment config: force-static treats this page as fully static
// Dynamic APIs (headers, cookies, searchParams) return empty/default values
export const dynamic = "force-static";

export default function StaticTestPage() {
  const timestamp = Date.now();
  return (
    <div data-testid="static-test-page">
      <h1>Force Static Page</h1>
      <p>
        Rendered at: <span data-testid="timestamp">{timestamp}</span>
      </p>
    </div>
  );
}
