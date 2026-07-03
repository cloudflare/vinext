import { Counter } from "./counter";
import { nextServerRenderCount } from "./state";

export const dynamic = "force-dynamic";

export default function Page() {
  const serverRenderCount = nextServerRenderCount();

  return (
    <main>
      <h1>Action Revalidate Remount</h1>
      <p id="server-render-count">{serverRenderCount}</p>
      <Counter />
    </main>
  );
}
