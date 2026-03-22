import { cookies } from "next/headers";
import { notFound } from "next/navigation";

export async function GET() {
  const cookieStore = await cookies();
  cookieStore.set("route-special", "not-found", { path: "/", httpOnly: true });
  notFound();
}
