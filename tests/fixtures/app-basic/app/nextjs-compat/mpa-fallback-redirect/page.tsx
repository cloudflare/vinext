import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignOut } from "./sign-out";

export const dynamic = "force-dynamic";

export default async function Page() {
  if ((await cookies()).has("mpa-fallback-signed-out")) {
    redirect("/nextjs-compat/mpa-fallback-redirect/login");
  }
  return <SignOut cookie="mpa-fallback-signed-out" />;
}
