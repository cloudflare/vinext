export function generateStaticParams() {
  return [];
}

export function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  return context.params.then(({ slug }) => Response.json({ kind: "static-empty", slug }));
}
