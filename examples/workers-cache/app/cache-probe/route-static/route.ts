export const revalidate = 300;

export function GET() {
  return new Response("cache-probe static route handler");
}
