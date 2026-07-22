import { cookies, headers } from "next/headers";

export default async function Page({ searchParams }: { searchParams: Promise<{ baz?: string }> }) {
  const cookieStore = await cookies();
  const headerStore = await headers();

  if (headerStore.get("next-action")) {
    throw new Error("Action header should not be present");
  }

  return (
    <main>
      <h1>Action Redirect Cookie Target</h1>
      <p id="target-theme">{cookieStore.get("theme")?.value ?? "missing"}</p>
      <p id="target-stale">{cookieStore.get("stale")?.value ?? "missing"}</p>
      <p id="target-baz">{(await searchParams).baz ?? "missing"}</p>
    </main>
  );
}
