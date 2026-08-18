import { getProvidersForRegion, getRequestRegion } from "../../provider-region/region";

export const dynamic = "force-dynamic";

type CloudflareRequest = Request & {
  cf?: { country?: string };
};

export async function GET(request: Request) {
  const headerCountry = request.headers.get("cf-ipcountry");
  const resolvedCountry = getRequestRegion(request.headers);

  return Response.json(
    {
      cfCountry: (request as CloudflareRequest).cf?.country ?? null,
      headerCountry,
      resolvedCountry,
      providers: getProvidersForRegion(resolvedCountry),
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
