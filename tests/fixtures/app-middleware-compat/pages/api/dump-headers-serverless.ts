import type { IncomingMessage, ServerResponse } from "node:http";

type Req = IncomingMessage & { headers: Record<string, string | string[] | undefined> };
type Res = ServerResponse & {
  status: (code: number) => Res;
  json: (value: unknown) => void;
};

export default function handler(req: Req, res: Res) {
  return res.status(200).setHeader("headers-from-serverless", "1").json(req.headers);
}
