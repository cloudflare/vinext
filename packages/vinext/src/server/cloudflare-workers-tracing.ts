// The ambient Workers types replace standard web globals, so vinext cannot load
// them into its shared Node/DOM type program. This module is injected only into
// Cloudflare builds and the capability we consume is typed by WorkersTracing.
// @ts-expect-error cloudflare:workers is provided by the Worker runtime.
import * as cloudflareWorkers from "cloudflare:workers";
import { registerFrameworkTracingIntegration } from "./tracer.js";
import { createWorkersTracingIntegration, type WorkersTracing } from "./workers-tracing.js";

// Older local workerd builds do not expose custom spans yet. Namespace access
// keeps those runtimes functional while current Workers register synchronously.
const tracing = Reflect.get(cloudflareWorkers, "tracing") as WorkersTracing | undefined;
if (tracing) {
  registerFrameworkTracingIntegration(createWorkersTracingIntegration(tracing));
}
