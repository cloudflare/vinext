import { HydrateWidget } from "./hydrate-widget";
import { VERSION } from "../version";

export default function HydrateTargetPage() {
  return (
    <main>
      <h1 id="target">Hydrate target {VERSION}</h1>
      <HydrateWidget />
    </main>
  );
}
