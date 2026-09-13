export function GET(request: Request) {
  const headers = new Headers({ "content-type": "text/plain" });
  const reflected = request.headers.get("x-vinext-static-file");
  if (reflected) headers.set("x-vinext-static-file", reflected);
  return new Response("route handler body", { headers });
}
