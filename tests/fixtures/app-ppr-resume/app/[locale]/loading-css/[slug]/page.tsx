import { cookies } from "next/headers";
import { Viewer } from "../viewer";

// A hole under loading.tsx: the shell holds the fallback, and the page, with
// the client component whose CSS it imports, reveals after it.
export default async function Page() {
  const name = (await cookies()).get("name")?.value ?? "guest";
  await new Promise((resolve) => setTimeout(resolve, 300));
  return <Viewer name={name} />;
}
