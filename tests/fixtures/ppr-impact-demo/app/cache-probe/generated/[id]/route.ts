export function generateStaticParams() {
  return [{ id: "known" }];
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return new Response(`cache components generated route: ${(await params).id}`);
}
