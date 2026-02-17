import { headers, cookies } from "next/headers";

export default async function HeadersTestPage() {
  // Test headers()
  const h = await headers();
  const userAgent = h.get("user-agent") || "unknown";

  // Test cookies()
  const c = await cookies();
  const allCookies = c.getAll();

  return (
    <div data-testid="headers-test-page">
      <h1>Headers/Cookies Test</h1>
      <p data-testid="user-agent">User-Agent: {userAgent.slice(0, 60)}...</p>
      <p data-testid="cookie-count">Cookies: {allCookies.length}</p>
      <p data-testid="timestamp">Timestamp: {Date.now()}</p>
    </div>
  );
}
