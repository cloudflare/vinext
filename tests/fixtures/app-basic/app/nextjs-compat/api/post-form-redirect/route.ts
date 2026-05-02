import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function POST(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set("route-redirect", "preserved", { path: "/" });

  redirect("/nextjs-compat/route-handler-redirects?success=true");
}
