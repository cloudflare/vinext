import { cookies } from "next/headers";

async function SessionGreeting() {
  // The cookie read lands after awaited I/O, so a client that leaves as soon
  // as the response headers arrive is gone before the render turns dynamic.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const session = (await cookies()).get("session")?.value;
  return <p id="late-cookie-read-session">signed in as {session ?? "guest"}</p>;
}

export default function LateCookieReadPage() {
  return (
    <main>
      <SessionGreeting />
    </main>
  );
}
