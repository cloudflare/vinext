import { cookies } from "next/headers";

// Throws without the cookie it reads. Its prerender has turned dynamic by
// then, so the build skips it, as Next.js's does.
export default async function Page() {
  const session = (await cookies()).get("session");
  if (!session) throw new Error("prerender-dynamic-throw: missing session cookie");
  return <p>{session.value}</p>;
}
