import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.appendHeader("Set-Cookie", "h=1; Path=/");
  res.appendHeader("x-multi", "a");
  res.appendHeader("x-multi", "b");
  res.status(200).json({
    ok: true,
    multi: res.getHeader("x-multi"),
    headersMulti: res.getHeaders()["x-multi"],
  });
}
