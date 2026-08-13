export const dynamic = "force-static";

type CloudflareRequest = Request & {
  cf?: { cacheKey?: string };
  method: string | undefined;
};

function shadowMethodWithCf(request: Request): CloudflareRequest {
  const shadowed = request as CloudflareRequest;
  Object.defineProperty(shadowed, "method", {
    configurable: true,
    get() {
      return (this as CloudflareRequest).cf?.cacheKey;
    },
  });
  return shadowed;
}

export async function GET(request: Request) {
  const afterDelete = shadowMethodWithCf(request);
  delete afterDelete.cf;

  const afterLock = shadowMethodWithCf(request.clone());
  Object.preventExtensions(afterLock);

  return Response.json({
    hidesCfAfterDelete: afterDelete.method === undefined,
    hidesCfAfterLock: afterLock.method === undefined,
  });
}
