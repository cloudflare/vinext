import { cookies, headers } from "next/headers";

export default function RequestApiSyncPage() {
  const headerStore = headers() as Promise<Headers> & Headers;
  const cookieStore = cookies() as Promise<any> & {
    get(name: string): { name: string; value: string } | undefined;
  };

  return (
    <main>
      <p id="sync-header">{headerStore.get("x-sync-header") ?? "missing"}</p>
      <p id="sync-cookie">{cookieStore.get("session")?.value ?? "missing"}</p>
    </main>
  );
}
