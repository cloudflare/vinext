// Used by tests/app-router-metadata-routes.test.ts: an exact route that must win
// over the generated image ids of ../icon.tsx.
export default async function Icon() {
  return new Response("nested icon", { headers: { "content-type": "text/plain" } });
}
