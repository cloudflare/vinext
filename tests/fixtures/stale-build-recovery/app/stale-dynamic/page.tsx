import { StaleDynamicHost } from "./stale-dynamic-host";
import { VERSION } from "../version";

export default function StaleDynamicPage() {
  return (
    <main>
      <h1 id="target">Stale dynamic {VERSION}</h1>
      <input id="draft" defaultValue="" />
      <a href="/slow-doc" id="slow-link">
        Slow document
      </a>
      <StaleDynamicHost />
    </main>
  );
}
