export const revalidate = 60;

export async function GET(request: Request) {
  const rewrapped = new Request(request);
  return Response.json({
    ping: rewrapped.headers.get("x-test-ping"),
  });
}
