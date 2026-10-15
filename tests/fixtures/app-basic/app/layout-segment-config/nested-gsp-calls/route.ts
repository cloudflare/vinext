import { takeStaticParamsCalls } from "../nested-gsp/static-params-calls";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(takeStaticParamsCalls());
}
