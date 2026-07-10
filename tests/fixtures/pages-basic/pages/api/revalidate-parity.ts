import type { NextApiRequest, NextApiResponse } from "next";
import {
  getRevalidateParityState,
  resetRevalidateParityGenerationCount,
  setRevalidateParityMode,
} from "../../revalidate-parity-state";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const mode = req.query.mode;
  const requestedRevalidate = Array.isArray(req.query.revalidate)
    ? req.query.revalidate[0]
    : req.query.revalidate;
  const invalidRevalidate = Array.isArray(req.query.invalid)
    ? req.query.invalid[0]
    : req.query.invalid;
  const revalidate: unknown = invalidRevalidate
    ? invalidRevalidate === "zero"
      ? 0
      : invalidRevalidate === "fractional"
        ? 1.5
        : invalidRevalidate === "infinity"
          ? Infinity
          : "invalid"
    : requestedRevalidate === "false"
      ? false
      : requestedRevalidate !== undefined && /^\d+$/.test(requestedRevalidate)
        ? Number(requestedRevalidate)
        : undefined;
  if (
    mode === "content" ||
    mode === "notFound" ||
    mode === "redirect" ||
    mode === "permanentRedirect" ||
    mode === "basePathFalseRedirect" ||
    mode === "conflictingRedirect" ||
    mode === "invalidStatusRedirect" ||
    mode === "externalRedirect" ||
    mode === "promised" ||
    mode === "concurrent" ||
    mode === "error"
  ) {
    setRevalidateParityMode(mode, revalidate);
  }

  if (req.query.reset === "1") {
    resetRevalidateParityGenerationCount();
    res.json({ revalidated: false, generationCount: 0 });
    return;
  }

  if (req.query.inspect === "1") {
    const state = getRevalidateParityState();
    res.json({ revalidated: false, generationCount: state.generationCount });
    return;
  }

  if (req.query.setOnly === "1") {
    res.json({ revalidated: false });
    return;
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
