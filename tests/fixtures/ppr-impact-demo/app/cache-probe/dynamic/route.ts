import { headers } from "next/headers";

export async function GET() {
  return new Response(`cache components dynamic route: ${(await headers()).get("user-agent")}`);
}
