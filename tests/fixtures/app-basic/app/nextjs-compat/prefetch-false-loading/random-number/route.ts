export function GET() {
  return new Response(crypto.randomUUID());
}
