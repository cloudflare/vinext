import { NEXT_ACTION_HEADER, RSC_ACTION_HEADER } from "./headers.js";

export function isPossibleAppRouteActionRequest(
  request: Pick<Request, "headers" | "method">,
): boolean {
  if (request.method.toUpperCase() !== "POST") return false;

  const contentType = request.headers.get("content-type");
  return (
    request.headers.has(RSC_ACTION_HEADER) ||
    request.headers.has(NEXT_ACTION_HEADER) ||
    // Next.js uses strict equality here, so charset variants intentionally do
    // not classify as action requests even though they are valid form posts.
    contentType === "application/x-www-form-urlencoded" ||
    contentType?.startsWith("multipart/form-data") === true
  );
}
