export const revalidate = false;

export function GET() {
  return Response.json({ timestamp: Date.now() });
}
