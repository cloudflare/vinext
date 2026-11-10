import { NextResponse } from "next/server";

export const config = { runtime: "edge" };

export default function handler() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set("edge-session", "abc123", { httpOnly: true, path: "/" });
  return response;
}
