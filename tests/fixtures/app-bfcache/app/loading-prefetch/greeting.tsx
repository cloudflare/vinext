import { cookies } from "next/headers";

// A hole: reads the request's cookies, then takes a while.
export async function Greeting() {
  const name = (await cookies()).get("name")?.value ?? "guest";
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return <p id="greeting">hello {name}</p>;
}
