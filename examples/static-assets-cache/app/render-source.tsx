// Deliberately import a native Worker module into the server bundle. Cloudflare's
// tracing integration adds the same specifier automatically on newer builds, and
// build-time prerendering must still be able to load the Worker graph in Node.
import * as workers from "cloudflare:workers";

/** Shows whether this HTML or RSC payload came from the build or from the Worker. */
export function RenderSource() {
  const source =
    process.env.VINEXT_PRERENDER === "1" && Reflect.get(workers, "tracing") === undefined
      ? "build-time"
      : "runtime";
  return (
    <p>
      Rendered at <span id="render-source">{source}</span>
    </p>
  );
}
