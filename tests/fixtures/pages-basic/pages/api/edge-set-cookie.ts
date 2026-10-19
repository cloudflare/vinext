// middleware.ts sets its own cookie on this route. Next.js keeps it ahead of
// the cookie an Edge API route returns.
export const config = {
  runtime: "edge",
};

export default function handler(): Response {
  return new Response("ok", { headers: { "set-cookie": "h=1; Path=/" } });
}
