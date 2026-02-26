export async function GET() {
  return Response.json({
    message: "Hello from vinext with nitro!",
    runtime: typeof globalThis.navigator !== "undefined"
      ? (globalThis.navigator as { userAgent?: string }).userAgent
      : "unknown",
  });
}
