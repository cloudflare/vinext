import { draftMode } from "next/headers";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  (await draftMode()).enable();
  return Response.json({ enabled: true });
}
