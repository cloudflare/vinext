// Cancels the request body one microtask after reading it, the same window as
// a rejected oversized Server Action. Used to check the dev server survives
// Node's Readable.toWeb() cancel race.
export async function POST(request: Request) {
  const body = request.body;
  await null;
  await body?.cancel();
  return new Response("cancelled");
}
