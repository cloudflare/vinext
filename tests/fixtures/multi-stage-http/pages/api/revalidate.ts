import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(request: NextApiRequest, response: NextApiResponse) {
  const path = typeof request.query.path === "string" ? request.query.path : "/";
  await response.revalidate(
    path,
    request.query.onlyGenerated === "1" ? { unstable_onlyGenerated: true } : undefined,
  );
  response.status(200).json({ revalidated: true });
}
