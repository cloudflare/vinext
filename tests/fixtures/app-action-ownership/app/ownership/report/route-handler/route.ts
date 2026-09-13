export async function POST(request: Request) {
  const formData = await request.formData();
  return Response.json(
    {
      marker: "ROUTE_HANDLER_EXECUTED",
      value: formData.get("value"),
    },
    { status: 202 },
  );
}
