import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignOut } from "../sign-out";

export const dynamic = "force-dynamic";

export default async function Page() {
  if ((await cookies()).has("mpa-fallback-to-pages")) {
    redirect("/old-school");
  }
  return <SignOut cookie="mpa-fallback-to-pages" />;
}
