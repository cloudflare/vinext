import { headers } from "next/headers";

export async function GET() {
  await headers();
  return new Response("Dynamic Route Handler with a response cache policy", {
    headers: { "Cache-Control": "s-maxage=300" },
  });
}
