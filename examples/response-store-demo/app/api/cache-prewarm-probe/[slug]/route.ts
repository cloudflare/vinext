import { loadPrewarmProbe } from "../../../cached/prewarm-probe";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return Response.json(await loadPrewarmProbe(slug), {
    headers: { "Cache-Control": "no-store" },
  });
}
