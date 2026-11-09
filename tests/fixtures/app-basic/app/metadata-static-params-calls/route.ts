import { takeStaticParamsCalls } from "../metadata-static-params/static-params-calls";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ calls: takeStaticParamsCalls() });
}
