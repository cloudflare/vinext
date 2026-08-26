import { getPrivateExecutions } from "../state";

export async function GET() {
  return Response.json({ privateExecutions: getPrivateExecutions() });
}
