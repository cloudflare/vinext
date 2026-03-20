// Route segment config: revalidate every 60 seconds (ISR)
export const revalidate = 60;

export default function RevalidateTestPage() {
  const timestamp = Date.now();
  return (
    <div data-testid="revalidate-test-page">
      <h1>ISR Revalidate Page</h1>
      <p>
        Rendered at: <span data-testid="timestamp">{timestamp}</span>
      </p>
      <p>Revalidates every 60 seconds</p>
    </div>
  );
}
