export const revalidate = 1;

export async function GET() {
  return new Response(
    JSON.stringify({
      timestamp: Date.now(),
      message: "static route handler with direct set-cookie header",
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": `session=${Date.now()}; Path=/; HttpOnly`,
      },
    },
  );
}
