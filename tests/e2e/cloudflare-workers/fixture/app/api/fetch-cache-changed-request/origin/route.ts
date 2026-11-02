export async function GET(request: Request) {
  return POST(request);
}

export async function POST(request: Request) {
  return Response.json({
    received: [
      new URL(request.url).searchParams.get("user"),
      request.headers.get("x-user"),
      await request.text(),
    ].join(" "),
    originRequestId: crypto.randomUUID(),
  });
}
