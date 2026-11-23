import { connection } from "next/server";
import { readServerWork } from "../../../lib/counters";

export async function GET() {
  await connection();
  return Response.json(readServerWork());
}
