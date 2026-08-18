import { getReactConditions } from "../../../lib/react-conditions";

export function GET() {
  return Response.json(getReactConditions());
}
