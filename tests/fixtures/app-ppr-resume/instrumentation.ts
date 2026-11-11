// A stand-in OpenTelemetry propagator that gives every render its own
// traceparent, so a document shows whose trace metadata it carries.
export function register() {
  let renders = 0;
  (globalThis as Record<symbol, unknown>)[Symbol.for("opentelemetry.js.api.1")] = {
    context: { active: () => ({}), with: <T>(_context: unknown, fn: () => T): T => fn() },
    propagation: {
      inject(
        _context: unknown,
        carrier: unknown,
        setter: { set(carrier: unknown, key: string, value: string): void },
      ) {
        renders += 1;
        setter.set(
          carrier,
          "traceparent",
          `00-${String(renders).padStart(32, "0")}-${"1".repeat(16)}-01`,
        );
      },
    },
  };
}
