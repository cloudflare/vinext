export async function GET() {
  return new Response("custom status text route", {
    status: 201,
    statusText: "Created",
  });
}
