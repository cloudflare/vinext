import { Suspense } from "react";
import { Greeting } from "../greeting";

export default function AboutPage() {
  return (
    <main>
      <h1 id="title">About</h1>
      <Suspense fallback={<p id="greeting-loading">Loading greeting…</p>}>
        <Greeting />
      </Suspense>
    </main>
  );
}
