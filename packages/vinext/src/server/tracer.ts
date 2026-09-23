import { createFrameworkTracer } from "./framework-tracer.js";
import type { FrameworkTracingIntegration } from "./framework-tracer.js";
import { openTelemetryTracingIntegration } from "./opentelemetry-tracing.js";

const INTEGRATIONS_KEY = Symbol.for("vinext.frameworkTracing.integrations");
const globals = globalThis as typeof globalThis & {
  [INTEGRATIONS_KEY]?: FrameworkTracingIntegration[];
};
const integrations = (globals[INTEGRATIONS_KEY] ??= []);

export function registerFrameworkTracingIntegration(
  integration: FrameworkTracingIntegration,
): void {
  if (!integrations.some(({ id }) => id === integration.id)) integrations.push(integration);
}

registerFrameworkTracingIntegration(openTelemetryTracingIntegration);

export const frameworkTracer = createFrameworkTracer(integrations);
