"use client";

import dynamic from "next/dynamic";

export const NextDynamicServerComponent = dynamic(() => import("../text-dynamic-server"));

export const NextDynamicServerImportClientComponent = dynamic(
  () => import("../text-dynamic-server-import-client"),
);
