// No page route matches this URL, so the client never receives its path.
export function GET() {
  return Response.json({ status: "internal" });
}
