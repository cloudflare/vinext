export const revalidate = 60;

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  return Response.json({
    renderToken: crypto.randomUUID(),
    slug: (await params).slug,
  });
}
