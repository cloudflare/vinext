"use client";

import { authClient } from "../lib/auth-client";

export function AuthStatus() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return <div data-testid="auth-loading">Loading session...</div>;
  }

  if (!session) {
    return <div data-testid="auth-signed-out">Not signed in</div>;
  }

  return (
    <div data-testid="auth-signed-in">
      Signed in as {session.user.email}
    </div>
  );
}
