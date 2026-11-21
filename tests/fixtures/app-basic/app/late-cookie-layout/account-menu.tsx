import { cookies } from "next/headers";

export async function AccountMenu() {
  // The cookie read lands after awaited I/O, once the document's shell and
  // its headers have already been sent.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const session = (await cookies()).get("session")?.value;
  return <p id="late-cookie-layout-session">signed in as {session ?? "guest"}</p>;
}
