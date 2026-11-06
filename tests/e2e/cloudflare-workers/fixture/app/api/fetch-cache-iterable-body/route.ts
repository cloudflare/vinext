export const dynamic = "force-dynamic";

async function* jsonBody(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  yield bytes.slice(0, 8);
  yield bytes.slice(8);
}

// Cached POSTs that differ only in their async iterable body must not share a
// data cache entry.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const origin = new URL("/api/fetch-cache-iterable-body/origin", request.url);
  const response = await fetch(origin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: jsonBody({
      caseId: searchParams.get("case"),
      visibility: searchParams.get("visibility"),
    }) as unknown as BodyInit,
    duplex: "half",
    next: { revalidate: 60 },
  } as RequestInit);
  return Response.json(await response.json());
}
