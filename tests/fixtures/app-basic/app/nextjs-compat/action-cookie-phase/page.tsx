import { cookies } from "next/headers";
import { setActionCookie } from "./actions";

export default function ActionCookiePhasePage() {
  const cookieStore = cookies() as Promise<any> & {
    get(name: string): { name: string; value: string } | undefined;
    set(name: string, value: string, options?: Record<string, unknown>): unknown;
  };

  let cookieError = "none";
  try {
    cookieStore.set("action-cookie", "render-write", { path: "/" });
  } catch (error) {
    cookieError = error instanceof Error ? error.message : String(error);
  }

  return (
    <main>
      <h1>Action Cookie Phase</h1>
      <p id="cookie-value">{cookieStore.get("action-cookie")?.value ?? "missing"}</p>
      <p id="cookie-error">{cookieError}</p>
      <form action={setActionCookie}>
        <button id="submit-action" type="submit">
          Set Cookie In Action
        </button>
      </form>
    </main>
  );
}
