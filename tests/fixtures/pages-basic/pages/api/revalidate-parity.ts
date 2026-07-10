import type { NextApiRequest, NextApiResponse } from "next";
import { getRevalidateParityState, setRevalidateParityMode } from "../../revalidate-parity-state";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const mode = req.query.mode;
  if (mode === "content" || mode === "notFound" || mode === "redirect") {
    setRevalidateParityMode(mode);
  }

  const target =
    req.query.headers === "1" ? "/api/revalidate-header-target" : "/revalidate-parity-target";
  await res.revalidate(target);
  const state = getRevalidateParityState();
  res.json({
    revalidated: true,
    capturedCookie: state.capturedCookie,
    capturedToken: state.capturedToken,
  });
}
