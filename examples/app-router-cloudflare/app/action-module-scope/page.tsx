import { ModuleScopeClient } from "./module-scope-client";

// The action modules are only referenced from a Client Component, so the first
// action request, not this render, is what evaluates them on the server.
export default function ActionModuleScopePage() {
  return (
    <main>
      <h1>Server action module scope</h1>
      <ModuleScopeClient />
    </main>
  );
}
