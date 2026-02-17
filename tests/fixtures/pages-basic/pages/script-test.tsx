import Script from "next/script";

export default function ScriptTestPage() {
  return (
    <div>
      <h1>Script Test</h1>
      <Script
        id="test-analytics"
        strategy="beforeInteractive"
        src="https://example.com/analytics.js"
      />
      <p>Page with scripts</p>
    </div>
  );
}
