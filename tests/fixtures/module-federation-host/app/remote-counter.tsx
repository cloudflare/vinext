"use client";

import dynamic from "next/dynamic";

// The vinext React bridge is browser-only, so the remote never renders on the server.
export const RemoteCounter = dynamic(
  // @ts-expect-error Module Federation provides this virtual module.
  () => import("remote/Counter") as Promise<{ default: React.ComponentType }>,
  { ssr: false, loading: () => <p>Loading remote counter…</p> },
);
