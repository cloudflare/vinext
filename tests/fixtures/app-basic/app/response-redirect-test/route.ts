// Response.redirect() creates immutable headers.
export function GET(request: Request) {
  return Response.redirect(new URL("/about", request.url), 302);
}
