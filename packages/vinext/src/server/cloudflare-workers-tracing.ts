import * as cloudflareWorkers from "cloudflare:workers";
import { registerFrameworkTracingIntegration } from "./tracer.js";
import { createWorkersTracingIntegration } from "./workers-tracing.js";

// Older local workerd builds do not expose custom spans yet. Namespace access
// keeps those runtimes functional while current Workers register synchronously.
if (cloudflareWorkers.tracing) {
  registerFrameworkTracingIntegration(createWorkersTracingIntegration(cloudflareWorkers.tracing));
}
