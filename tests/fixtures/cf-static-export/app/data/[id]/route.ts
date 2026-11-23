export const dynamic = "force-static";

export function generateStaticParams() {
  return [{ id: "known" }];
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return Response.json({ id });
}
