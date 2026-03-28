import { cookies, headers } from "next/headers";

export const dynamic = "error";

export default function RequestApiDynamicErrorPage() {
  let headerError = "missing";
  let cookieError = "missing";

  try {
    (headers() as Promise<Headers> & Headers).set("x-test", "mutated");
  } catch (error) {
    headerError = error instanceof Error ? error.message : String(error);
  }

  try {
    (
      cookies() as Promise<any> & {
        set(name: string, value: string): unknown;
      }
    ).set("session", "mutated");
  } catch (error) {
    cookieError = error instanceof Error ? error.message : String(error);
  }

  return (
    <main>
      <h1>Request API Dynamic Error</h1>
      <p id="header-error">{headerError}</p>
      <p id="cookie-error">{cookieError}</p>
    </main>
  );
}
