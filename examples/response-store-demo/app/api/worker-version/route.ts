import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

// The deployed version, whose preview URL is a second host of this Worker.
export function GET(): Response {
  const metadata = Reflect.get(env, "CF_VERSION_METADATA") as WorkerVersionMetadata | undefined;
  return Response.json({ id: metadata?.id ?? null }, { headers: { "Cache-Control": "no-store" } });
}
