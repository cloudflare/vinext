import { revalidatePath } from "next/cache";

export const dynamic = "force-dynamic";

type Body = { path?: unknown };

export async function POST(request: Request): Promise<Response> {
  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const path = typeof payload.path === "string" ? payload.path.trim() : "";
  if (!path || !path.startsWith("/")) {
    return Response.json({ error: "Path must be a leading-slash route" }, { status: 400 });
  }

  // vinext turns the path into its cache tags and passes them to the configured
  // Workers Response Store adapter.
  await revalidatePath(path);
  return Response.json({ revalidated: true, target: path });
}
