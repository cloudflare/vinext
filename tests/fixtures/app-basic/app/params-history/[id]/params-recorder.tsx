"use client";

import { useParams, usePathname, useSearchParams } from "next/navigation";

type RecorderWindow = Window & { __PARAMS_HISTORY_RENDERS__?: string[] };

// Records the params and URL every render observes, so a test can catch a
// render that briefly sees another route's values.
export function ParamsRecorder() {
  const params = useParams<{ id?: string }>();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const id = params?.id ?? "(missing)";
  if (typeof window !== "undefined") {
    const recorderWindow = window as RecorderWindow;
    (recorderWindow.__PARAMS_HISTORY_RENDERS__ ??= []).push(`${id} ${pathname}?${search}`);
  }
  return (
    <>
      <p id="params-history-id">{id}</p>
      <p id="params-history-search">{search}</p>
    </>
  );
}
