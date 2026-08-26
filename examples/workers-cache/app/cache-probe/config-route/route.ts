export const revalidate = 0;

export function GET() {
  return new Response("Route Handler with an explicit config cache policy");
}
