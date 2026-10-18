import { cache, cacheSignal } from "react";
import { cookies } from "next/headers";
import { connection } from "next/server";

// Each loader is called by generateMetadata()/generateViewport() and by the
// page or a layout. Next.js resolves the head inside the page's Flight render,
// so both callers share one React cache() value per request.

export const getRandom = cache(() => Math.random().toString());

export const getThemeColor = cache(
  () =>
    `#${Math.floor(Math.random() * 0x1000000)
      .toString(16)
      .padStart(6, "0")}`,
);

// connection() never settles in vinext's layout probes, so a probe must not
// hand this loader's promise to the render.
export const getLive = cache(async () => {
  await connection();
  return Math.random().toString();
});

export const getUser = cache(
  async () => (await cookies()).get("metadata-react-cache-user")?.value ?? "anonymous",
);

// cacheSignal() is only non-null inside a Flight render.
export const getSignalState = cache(() => (cacheSignal() ? "in-render" : "outside-render"));
