import type { NextApiRequest, NextApiResponse } from "next";
import {
  installCustomRevalidateCache,
  restoreCustomRevalidateCache,
} from "../../custom-revalidate-cache";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const kind = Array.isArray(req.query.kind) ? req.query.kind[0] : req.query.kind;
  if (kind === "restore") {
    restoreCustomRevalidateCache();
    res.json({ restored: true });
    return;
  }

  if (kind === "redirect") {
    installCustomRevalidateCache({
      kind: "REDIRECT",
      props: {
        pageProps: {
          __N_REDIRECT: "/about",
          __N_REDIRECT_STATUS: 308,
          __N_REDIRECT_BASE_PATH: false,
        },
      },
    });
  } else if (kind === "notFound") {
    installCustomRevalidateCache(null);
  } else if (kind === "legacyRedirect") {
    installCustomRevalidateCache({
      kind: "PAGES",
      html: "",
      pageData: {},
      headers: { Location: "/about" },
      status: 307,
    });
  } else if (kind === "legacyNotFound") {
    installCustomRevalidateCache({
      kind: "PAGES",
      html: "",
      pageData: {},
      headers: undefined,
      status: 404,
    });
  } else {
    res.status(400).json({ installed: false });
    return;
  }
  res.json({ installed: true, kind });
}
