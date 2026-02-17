import { auth } from "../../lib/auth";
import { headers } from "next/headers";

export default async function ProtectedPage() {
  // Exercise server-side session access via next/headers shim.
  // This validates that headers() works with better-auth's getSession.
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  return (
    <div>
      <h1 data-testid="protected-heading">Protected Page</h1>
      <div data-testid="session-status">
        {session ? `Logged in as ${session.user.email}` : "Not logged in"}
      </div>
    </div>
  );
}
