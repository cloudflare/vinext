import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function RedirectingPage(): Promise<never> {
  await cookies();
  redirect("/");
}
