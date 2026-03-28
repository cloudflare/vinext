export default function OverrideFromMiddlewarePage() {
  return (
    <main>
      <h1>Headers Override From Middleware</h1>
      <p>
        This page is used to test that middleware response headers always override next.config.js
        headers for the same key, matching Next.js behavior.
      </p>
    </main>
  );
}
