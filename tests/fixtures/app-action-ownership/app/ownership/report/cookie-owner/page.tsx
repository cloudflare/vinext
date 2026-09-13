import { cookies, headers } from "next/headers";
import { ActionButton } from "../../action-button";

export default function Page() {
  const readForwardedCredentials = async () => {
    "use server";
    const auth = (await headers()).get("x-forwarded-auth") ?? "missing";
    const cookieStore = await cookies();
    const cookie = cookieStore.get("forwarded-cookie")?.value ?? "missing";
    cookieStore.set("owner-action", "present");
    return `${auth}:${cookie}`;
  };

  return <ActionButton id="forwarded-credentials" action={readForwardedCredentials} />;
}
