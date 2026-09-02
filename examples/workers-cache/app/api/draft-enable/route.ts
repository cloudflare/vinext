import { draftMode } from "next/headers";

export async function GET() {
  (await draftMode()).enable();
  return Response.json({ enabled: true });
}
