import type { NextApiRequest, NextApiResponse } from "next";

// Mirrors Next.js's upstream test fixture
// (`test/e2e/revalidate-reason/pages/api/revalidate.ts`): triggers on-demand
// revalidation of the `/revalidate-reason` page via `res.revalidate()`.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ revalidated: boolean }>,
) {
  try {
    const path = typeof req.query.path === "string" ? req.query.path : "/revalidate-reason";
    await res.revalidate(path, {
      unstable_onlyGenerated: req.query.onlyGenerated === "1",
    });
    res.json({ revalidated: true });
    return;
  } catch (err) {
    console.error("Failed to revalidate:", err);
  }

  res.json({ revalidated: false });
}
