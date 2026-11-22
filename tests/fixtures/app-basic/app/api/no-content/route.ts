export const revalidate = 60;

export function GET() {
  return new Response(null, { status: 204 });
}
