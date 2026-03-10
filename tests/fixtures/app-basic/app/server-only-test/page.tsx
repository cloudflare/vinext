import "server-only";

// This page imports "server-only" which should work fine in a Server Component.
// The import is a build-time guard — it ensures this module is never accidentally
// included in a client bundle.

export default function ServerOnlyPage() {
  return (
    <div>
      <h1 data-testid="server-only-heading">Server Only Page</h1>
      <p data-testid="server-only-message">This component successfully imported server-only</p>
    </div>
  );
}
