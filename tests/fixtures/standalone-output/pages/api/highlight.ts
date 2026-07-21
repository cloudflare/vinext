import type { NextApiRequest, NextApiResponse } from "next";
import { codeToHtml } from "shiki";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const html = await codeToHtml("const answer: number = 42;", {
    lang: "typescript",
    theme: "github-dark-default",
  });

  res.status(200).json({ html });
}
