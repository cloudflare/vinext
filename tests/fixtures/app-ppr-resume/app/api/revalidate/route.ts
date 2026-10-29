import { revalidateTag } from "next/cache";

export async function POST() {
  revalidateTag("regenerated", "max");
  return new Response("revalidated");
}
