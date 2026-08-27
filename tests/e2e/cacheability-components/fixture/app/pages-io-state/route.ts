import { readPagesIoRenderCount, resetPagesIoRenderCount } from "../../pages-io-state";

export function DELETE(): Response {
  resetPagesIoRenderCount();
  return new Response(null, { status: 204 });
}

export function GET(): Response {
  return Response.json({ renderCount: readPagesIoRenderCount() });
}
