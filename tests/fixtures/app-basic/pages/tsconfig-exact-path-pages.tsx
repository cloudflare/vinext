// See app/tsconfig-exact-path/page.tsx.
import { useEffect, useState } from "react";
import { entrySource } from "fake-tsconfig-exact-lib";
import { runtimeSource } from "fake-tsconfig-exact-lib/runtime";

export default function TsconfigExactPathPagesPage() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <main data-testid="client" data-hydrated={hydrated ? "true" : undefined}>
      <p data-testid="client-entry">{entrySource}</p>
      <p data-testid="client-runtime">{runtimeSource}</p>
    </main>
  );
}
