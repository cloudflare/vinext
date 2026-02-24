// Server component that renders a client wrapper using dynamic() with ssr:false.
// Tests that the "use client" directive on the dynamic shim creates a proper
// client boundary — the server component imports the client wrapper which
// calls dynamic(), and the dynamically loaded component appears after hydration.
import ClientWrapper from "./client-wrapper";

export default function Page() {
  return (
    <div id="content">
      <p id="server-text">Server rendered</p>
      <ClientWrapper />
    </div>
  );
}
