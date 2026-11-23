import { Suspense } from "react";
import { Greeting } from "../greeting";

export default function HoledPage() {
  return (
    <main>
      <p id="route-content">holed static part</p>
      <Suspense fallback={<p id="greeting-loading">Loading greeting…</p>}>
        <Greeting />
      </Suspense>
    </main>
  );
}
