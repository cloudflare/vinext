export async function GET() {
  return new Response(
    "API Node instrumentationFinished=" + (globalThis as any).instrumentationFinished,
  );
}
