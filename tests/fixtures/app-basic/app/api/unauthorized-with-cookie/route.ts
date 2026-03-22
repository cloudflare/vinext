import { cookies } from "next/headers";
import { unauthorized } from "next/navigation";

export async function GET() {
  const cookieStore = await cookies();
  cookieStore.set("route-special", "unauthorized", { path: "/", httpOnly: true });
  unauthorized();
}
