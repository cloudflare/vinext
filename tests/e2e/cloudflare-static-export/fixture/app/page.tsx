import * as workers from "cloudflare:workers";

export default function Page() {
  return (
    <main>
      <h1>Cloudflare static export</h1>
      <p id="export-probe">
        {process.env.VINEXT_PRERENDER === "1" && Reflect.get(workers, "tracing") === undefined
          ? "build-time"
          : "runtime"}
      </p>
    </main>
  );
}
