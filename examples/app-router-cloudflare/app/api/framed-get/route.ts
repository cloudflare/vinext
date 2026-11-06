import { NextRequest } from "next/server";

// Workers hands a GET sent with Content-Length a non-null body; Next.js never
// lets user code see one, so rebuilding the request must not throw either.
export async function GET(request: NextRequest) {
  const url = new URL("/api/framed-get", request.url);
  const bodyNull = request.body === null;
  return Response.json(
    {
      bodyNull,
      requestBodyNull: new Request(url, request).body === null,
      nextRequestBodyNull: new NextRequest(url, request).body === null,
    },
    // A HEAD response drops the JSON, so report the handler's view in a header too.
    { headers: { "x-route-body-null": String(bodyNull) } },
  );
}
