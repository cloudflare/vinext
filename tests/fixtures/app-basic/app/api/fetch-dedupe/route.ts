export async function GET() {
  const target = process.env.TEST_FETCH_DEDUPE_TARGET;
  if (!target) {
    return Response.json({ error: "missing TEST_FETCH_DEDUPE_TARGET" }, { status: 500 });
  }

  const first = await fetch(target, { cache: "no-store" });
  const second = await fetch(target, { cache: "no-store" });
  const firstBody = (await first.json()) as { count: number };
  const secondBody = (await second.json()) as { count: number };

  return Response.json({ counts: [firstBody.count, secondBody.count] });
}
