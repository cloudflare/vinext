// Fixture for classifyAppRoute test: dynamic="error" should classify as static.
// In Next.js, dynamic="error" enforces static rendering by throwing if any
// dynamic API (headers, cookies, etc.) is used — the page is statically rendered.
export const dynamic = "error";

export default function ErrorStaticPage() {
  return <p>error-static</p>;
}
