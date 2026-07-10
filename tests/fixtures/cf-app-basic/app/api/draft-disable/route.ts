import { draftMode } from "next/headers";

export async function GET() {
  (await draftMode()).disable();
  return Response.json({ disabled: true });
}
