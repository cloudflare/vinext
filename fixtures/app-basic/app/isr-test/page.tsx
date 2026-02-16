// Route segment config: revalidate every 1 second (short TTL for E2E testing)
export const revalidate = 1;

export default function ISRTestPage() {
  const timestamp = Date.now();
  return (
    <div data-testid="isr-test-page">
      <h1>App Router ISR Test</h1>
      <p>
        Timestamp: <span data-testid="timestamp">{timestamp}</span>
      </p>
      <p data-testid="message">Hello from ISR</p>
    </div>
  );
}
