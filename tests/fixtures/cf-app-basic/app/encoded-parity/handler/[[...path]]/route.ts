export async function GET(_request: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  return Response.json({ path: path ?? null });
}
