import { cookies } from "next/headers";
import { countServerWork } from "../../lib/counters";

// A hole: reads the request's cookies, then takes a while.
export async function Greeting({ delayMs = 1500 }: { delayMs?: number }) {
  const name = (await cookies()).get("name")?.value ?? "guest";
  countServerWork("greeting");
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return <p id="greeting">hello {name}</p>;
}
