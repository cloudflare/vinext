export function GET(request: Request) {
  const doc = new URL(request.url).searchParams.get("doc") ?? "";
  return new Response(doc, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": 'attachment; filename="note.txt"',
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
