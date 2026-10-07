const REQUESTS = "__SEARCH_PARAMS_GATE_DATA_REQUESTS__";

export async function GET() {
  // The test runs this server in its own process and reads the count.
  Reflect.set(globalThis, REQUESTS, Number(Reflect.get(globalThis, REQUESTS) ?? 0) + 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return new Response("client-data");
}
