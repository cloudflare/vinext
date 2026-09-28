import { cacheLife } from "next/cache";

async function getCachedAt(): Promise<string> {
  "use cache";
  cacheLife({ revalidate: 60 });
  return new Date().toISOString();
}

// A static page whose only revalidate source is a 60 second cacheLife.
export default async function CacheLifePage() {
  const cachedAt = await getCachedAt();

  return (
    <main>
      <h1>
        <code>/cache-life</code>
      </h1>
      <p>
        Data cached at: <code>{cachedAt}</code>
      </p>
      <p>
        Render ID: <code data-testid="cache-life-render-id">{crypto.randomUUID()}</code>
      </p>
    </main>
  );
}
