import { cookies, headers } from "next/headers";

/**
 * Reads the request while a server action module is first evaluated. Next.js
 * rejects request APIs at module scope; if this ever resolved, the first
 * caller's session would be cached in the module for every later caller.
 */
export function readModuleScopeRequest(): Promise<string> {
  const read = async () => {
    const session = (await cookies()).get("session")?.value ?? "none";
    const header = (await headers()).get("x-session") ?? "none";
    return `leaked:${session}:${header}`;
  };
  return read().catch(() => "rejected");
}
