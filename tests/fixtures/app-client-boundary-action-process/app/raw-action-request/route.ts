export async function POST(request: Request) {
  const formData = await request.formData();
  return Response.json({ field: formData.get("ordinary-field") });
}
