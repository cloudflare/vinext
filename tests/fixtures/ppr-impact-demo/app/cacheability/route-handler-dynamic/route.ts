import { headers } from "next/headers";

export const revalidate = 60;

export async function GET() {
  const requestHeaders = await headers();
  return Response.json({ value: requestHeaders.get("X-Probe-Value") ?? "none" });
}
