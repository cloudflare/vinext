import { cookies, headers } from "next/headers";

export default function RequestApiReadonlyPage() {
  const headerStore = headers() as Promise<Headers> & Headers;
  const cookieStore = cookies() as Promise<any> & {
    get(name: string): { name: string; value: string } | undefined;
    set(name: string, value: string, options?: Record<string, unknown>): unknown;
  };

  let headerError = "none";
  let cookieError = "none";

  try {
    headerStore.set("x-test-page", "mutated");
  } catch (error) {
    headerError = error instanceof Error ? error.message : String(error);
  }

  try {
    cookieStore.set("session", "mutated", { httpOnly: true });
  } catch (error) {
    cookieError = error instanceof Error ? error.message : String(error);
  }

  return (
    <main>
      <p id="header-error">{headerError}</p>
      <p id="cookie-error">{cookieError}</p>
      <p id="header-value">{headerStore.get("x-test-page") ?? "missing"}</p>
      <p id="cookie-value">{cookieStore.get("session")?.value ?? "missing"}</p>
    </main>
  );
}
