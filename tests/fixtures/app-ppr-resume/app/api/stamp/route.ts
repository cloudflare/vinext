import { connection } from "next/server";
import { countServerWork, readServerWork } from "../../../lib/counters";

// Per-request data for the feed's uncached fetch.
export async function GET() {
  await connection();
  countServerWork("stamp");
  return new Response(`stamp ${readServerWork().stamp}`);
}
