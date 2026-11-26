// instrumentation.spec.ts asserts on the errors recorded for this path alone,
// while api-routes.spec.ts requests the parent route in parallel.
export async function GET() {
  throw new Error("Intentional route handler error");
}
