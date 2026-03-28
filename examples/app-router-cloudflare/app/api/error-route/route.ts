// Route that throws an error — used by instrumentation e2e tests to verify
// that onRequestError() is called when a route handler throws.
export async function GET() {
  throw new Error("Intentional route handler error");
}
