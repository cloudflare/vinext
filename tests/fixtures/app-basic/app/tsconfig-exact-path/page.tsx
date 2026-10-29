// tsconfig maps the exact key `fake-tsconfig-exact-lib` to the package's
// src/index.js. Like TypeScript and Next.js, the `/runtime` subpath must not
// match that key and resolves through the package's `exports`.
import { entrySource } from "fake-tsconfig-exact-lib";
import { runtimeSource } from "fake-tsconfig-exact-lib/runtime";
import { TsconfigExactPathClient } from "./client";

export default function TsconfigExactPathPage() {
  return (
    <main>
      <p data-testid="server-entry">{entrySource}</p>
      <p data-testid="server-runtime">{runtimeSource}</p>
      <TsconfigExactPathClient />
    </main>
  );
}
