export const revalidate = 60;

// An ISR route handler that never reads the request, so Next.js stores one
// response for every host the app serves.
export function GET(): Response {
  return Response.json({ renderId: crypto.randomUUID() });
}
