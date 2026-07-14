export async function POST(request: Request) {
  return Response.json({
    body: await request.text(),
    contentType: request.headers.get("content-type"),
    nextAction: request.headers.get("next-action"),
    rscAction: request.headers.get("x-rsc-action"),
  });
}
