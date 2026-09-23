// Deliberately force a native Worker import into the server bundle. Cloudflare's
// tracing integration adds the same specifier automatically on newer builds.
import * as workers from "cloudflare:workers";

export default function Page() {
  return (
    <main>
      <h1>Prerendered Static Assets</h1>
      <p id="prerender-probe">
        {process.env.VINEXT_PRERENDER === "1" && Reflect.get(workers, "tracing") === undefined
          ? "build-time"
          : "runtime"}
      </p>
      <a href="/about">About</a>
    </main>
  );
}
