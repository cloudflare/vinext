import type { NextApiRequest, NextApiResponse } from "next";
import { getRevalidateParityState } from "../../revalidate-parity-state";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const state = getRevalidateParityState();
  state.capturedCookie = typeof req.headers.cookie === "string" ? req.headers.cookie : null;
  state.capturedToken =
    typeof req.headers["x-revalidate-token"] === "string"
      ? req.headers["x-revalidate-token"]
      : null;
  res.status(200).end();
}
