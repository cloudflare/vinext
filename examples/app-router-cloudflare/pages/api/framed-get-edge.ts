export const config = { runtime: "edge" };

export default function handler(request: Request) {
  return Response.json({ bodyNull: request.body === null });
}
