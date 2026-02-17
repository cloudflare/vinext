import { connection } from "next/server";

// Despite having revalidate=60, calling connection() during render
// should force dynamic rendering (no caching, no-store headers).
export const revalidate = 60;

export default async function ConnectionTestPage() {
  await connection();

  return (
    <div data-testid="connection-test-page">
      <h1>Connection Test</h1>
      <p>
        Timestamp: <span data-testid="timestamp">{Date.now()}</span>
      </p>
      <p data-testid="message">This page uses connection() for dynamic rendering</p>
    </div>
  );
}
