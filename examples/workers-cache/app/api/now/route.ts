// Cached App Route handler. The response-store adapter persists vinext's
// binary APP_ROUTE cache value for one second so the POC can exercise SWR.
export const revalidate = 1;

export async function GET(): Promise<Response> {
  // `renderId` is freshly generated on every handler invocation. The client
  // probe compares it against the previous probe's renderId to tell whether
  // a fresh response was produced or the same cached body was re-served.
  return Response.json({
    now: new Date().toISOString(),
    renderId: crypto.randomUUID(),
    random: Math.random(),
    note: "Cached by vinext + Workers Response Store with one-second freshness.",
  });
}
