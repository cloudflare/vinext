// Cached App Route handler. vinext emits ISR Cache-Control headers and a
// Cache-Tag for the path so the Workers Cache layer caches the response
// for 30 seconds and tag-based revalidation works.
export const revalidate = 30;

export async function GET(): Promise<Response> {
  // `renderId` is freshly generated on every handler invocation. The client
  // probe compares it against the previous probe's renderId to tell whether
  // a fresh response was produced or the same cached body was re-served.
  return Response.json({
    now: new Date().toISOString(),
    renderId: crypto.randomUUID(),
    random: Math.random(),
    note: "Cached by vinext + Workers Cache for 30 seconds.",
  });
}
