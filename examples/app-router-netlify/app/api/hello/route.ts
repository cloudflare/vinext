export async function GET() {
  return Response.json({
    message: "Hello from vinext on Netlify!",
    runtime: typeof globalThis.navigator !== "undefined"
      ? (globalThis.navigator as { userAgent?: string }).userAgent
      : "unknown",
  });
}
