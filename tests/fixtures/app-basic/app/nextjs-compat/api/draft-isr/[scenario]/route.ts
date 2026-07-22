import { draftMode } from "next/headers";

export const revalidate = 60;

export async function GET() {
  return Response.json({
    draftMode: (await draftMode()).isEnabled,
    token: crypto.randomUUID(),
  });
}
