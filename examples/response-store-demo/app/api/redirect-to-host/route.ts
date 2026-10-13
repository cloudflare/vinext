import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

export const revalidate = 60;

// Reading the host before redirect() is a dynamic API, so next.config's public
// provider policy cannot share one host's redirect with every host.
export function GET(request: NextRequest): never {
  redirect(`/static-default?from=${request.nextUrl.hostname}`);
}
