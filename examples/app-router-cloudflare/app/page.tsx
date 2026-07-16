import { Counter } from "./components/counter";

// The example's E2E coverage expects the rendered timestamp to change per request.
export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <main>
      <h1>vinext on Cloudflare Workers</h1>
      <p>This page is server-rendered by vinext running inside Cloudflare Workers.</p>
      <p data-testid="timestamp">Rendered at: {new Date().toISOString()}</p>
      <Counter />
      <nav>
        <ul>
          <li><a href="/about">About</a></li>
          <li><a href="/action-revalidate">Action revalidation</a></li>
          <li><a href="/api/hello">API Route</a></li>
        </ul>
      </nav>
    </main>
  );
}
