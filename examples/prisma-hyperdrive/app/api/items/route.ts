import { getPrisma } from "@/lib/db";

export async function GET() {
  const prisma = getPrisma();
  const items = await prisma.item.findMany({ orderBy: { createdAt: "desc" } });
  return Response.json(items);
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  let title: string | null = null;

  if (contentType.includes("application/json")) {
    const body = await request.json();
    title = body.title;
  } else {
    // Form submission
    const formData = await request.formData();
    title = formData.get("title") as string;
  }

  if (!title?.trim()) {
    return Response.json({ error: "title is required" }, { status: 400 });
  }

  const prisma = getPrisma();
  const item = await prisma.item.create({ data: { title: title.trim() } });

  // Redirect back to home on form submit, return JSON for API calls
  if (!contentType.includes("application/json")) {
    return new Response(null, { status: 303, headers: { Location: "/" } });
  }
  return Response.json(item, { status: 201 });
}
