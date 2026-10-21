export const revalidate = 3600;

export function generateStaticParams() {
  return [{ tenant: "a" }, { tenant: "b" }];
}

// The request-stage rewrite carries the tenant in the pathname. The render
// reads only route params, so hostname reads cannot make this response dynamic.
export async function GET(_request: Request, { params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  return Response.json({ tenant, renderId: crypto.randomUUID() });
}
