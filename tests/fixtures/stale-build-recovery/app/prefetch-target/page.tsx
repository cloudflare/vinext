import { PrefetchWidget } from "./prefetch-widget";
import { VERSION } from "../version";

export default function PrefetchTargetPage() {
  return (
    <main>
      <h1 id="target">Prefetch target {VERSION}</h1>
      <PrefetchWidget />
    </main>
  );
}
