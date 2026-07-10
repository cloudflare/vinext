export const revalidate = false;

export function GET() {
  return Response.json({ ok: true, source: "revalidate false route handler" });
}
