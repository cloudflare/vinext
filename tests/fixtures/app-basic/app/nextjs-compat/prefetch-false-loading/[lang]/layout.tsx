import type { ReactNode } from "react";
import { headers } from "next/headers";
import { SharedLayoutMountMarker } from "./shared-layout-mount-marker";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function PrefetchFalseLoadingLangLayout({
  children,
}: {
  children: ReactNode;
}) {
  await delay(200);
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  if (host === null) {
    throw new Error("Missing request host for prefetch=false loading fixture");
  }
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const data = await fetch(
    `${protocol}://${host}/nextjs-compat/prefetch-false-loading/random-number`,
    { cache: "no-store" },
  );
  const randomNumber = await data.text();

  return (
    <div>
      <p id="random-number">{randomNumber}</p>
      <SharedLayoutMountMarker />
      {children}
    </div>
  );
}
