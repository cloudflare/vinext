export async function POST(request: Request) {
  return Response.json({
    body: await request.json(),
    originRequestId: crypto.randomUUID(),
  });
}
