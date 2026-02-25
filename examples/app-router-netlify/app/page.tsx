import { Counter } from "./components/counter";

export default function HomePage() {
  return (
    <main>
      <h1>vinext on Netlify</h1>
      <p>This page is server-rendered by vinext running on Netlify.</p>
      <p data-testid="timestamp">Rendered at: {new Date().toISOString()}</p>
      <Counter />
      <nav>
        <ul>
          <li><a href="/about">About</a></li>
          <li><a href="/api/hello">API Route</a></li>
        </ul>
      </nav>
    </main>
  );
}
