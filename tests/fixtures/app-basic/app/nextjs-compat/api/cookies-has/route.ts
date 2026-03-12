import { cookies } from "next/headers";

export async function GET() {
  const cookieStore = await cookies();

  return Response.json({
    hasSession: cookieStore.has("session"),
    hasMissing: cookieStore.has("missing"),
  });
}
