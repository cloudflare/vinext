import { cacheLife, cacheTag } from "next/cache";

// This page has function-level "use cache" (not file-level).
// The getData function is cached, but the page component itself is not.

async function getData() {
  "use cache";
  cacheLife("seconds");
  cacheTag("fn-cache-data");
  return { value: Date.now() };
}

export default async function UseCacheFnTestPage() {
  const data = await getData();

  return (
    <div data-testid="use-cache-fn-test-page">
      <h1>Use Cache Function Test</h1>
      <p>
        Data Value: <span data-testid="data-value">{data.value}</span>
      </p>
      <p>
        Page Timestamp: <span data-testid="page-timestamp">{Date.now()}</span>
      </p>
      <p data-testid="message">This page uses function-level &quot;use cache&quot;</p>
    </div>
  );
}
