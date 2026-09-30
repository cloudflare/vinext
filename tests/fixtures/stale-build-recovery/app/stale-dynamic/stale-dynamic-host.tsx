"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { VERSION } from "../version";

const StaleWidget = dynamic(() => import("./stale-widget"), { ssr: false });

// A loader that hands back one promise forever: a rejection stays rejected and
// the loader must never run a second time.
const failingLoad: Promise<ComponentType> =
  typeof window === "undefined"
    ? new Promise(() => {})
    : Promise.reject(new Error("PROMISE_FORM_FAILURE"));
failingLoad.catch(() => {});
const PromiseFormWidget = dynamic(failingLoad, { ssr: false });

type Shown = "none" | "promise-form" | "widget";

export function StaleDynamicHost() {
  const router = useRouter();
  const [shown, setShown] = useState<Shown>("none");

  return (
    <section data-version={VERSION}>
      <button id="show-widget" onClick={() => setShown("widget")} type="button">
        Show widget
      </button>
      <button id="show-promise-form" onClick={() => setShown("promise-form")} type="button">
        Show promise form
      </button>
      <button id="refresh" onClick={() => router.refresh()} type="button">
        Refresh
      </button>
      {shown === "widget" ? <StaleWidget /> : null}
      {shown === "promise-form" ? <PromiseFormWidget /> : null}
    </section>
  );
}
