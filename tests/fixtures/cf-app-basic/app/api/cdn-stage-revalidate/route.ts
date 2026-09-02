import { revalidatePath } from "next/cache";

export async function POST(request: Request) {
  const { pathname } = (await request.json()) as { pathname: string };
  revalidatePath(pathname);
  return Response.json({ revalidated: pathname });
}
