import { AuthStatus } from "./auth-status";

export default function Home() {
  return (
    <div>
      <h1>better-auth test</h1>
      <p data-testid="ssr-content">Server-rendered content</p>
      <AuthStatus />
    </div>
  );
}
