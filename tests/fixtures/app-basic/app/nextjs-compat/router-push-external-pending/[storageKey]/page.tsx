"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { use, useEffect, useRef, useState, useTransition } from "react";

let listening = false;

type BrowserNavigationEvent = Event & {
  destination?: {
    url?: string;
  };
};

type BrowserNavigation = EventTarget & {
  addEventListener(type: "navigate", listener: (event: BrowserNavigationEvent) => void): void;
};

function readBrowserNavigation(): BrowserNavigation | null {
  const maybeNavigation = Reflect.get(window, "navigation");
  if (
    maybeNavigation instanceof EventTarget &&
    typeof Reflect.get(maybeNavigation, "addEventListener") === "function"
  ) {
    return maybeNavigation;
  }
  return null;
}

function getPersistentStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  // Playwright/Chromium can lose sessionStorage when the test hops through the
  // external origin; localStorage keeps the upstream signal observable.
  return window.localStorage;
}

function readStorage(storageKey: string): Record<string, string> {
  const storage = getPersistentStorage();
  if (storage === null) return {};

  return Object.fromEntries(
    Object.entries(storage).flatMap(([key, value]) =>
      key.startsWith(`${storageKey}/`) ? [[key.slice(storageKey.length + 1), value]] : [],
    ),
  );
}

export default function Page({ params }: { params: Promise<{ storageKey: string }> }) {
  const storageKey = use(params).storageKey;
  const router = useRouter();
  const searchParams = useSearchParams().toString();
  const pathname = usePathname();
  const path = searchParams ? `${pathname}?${searchParams}` : pathname;
  const [isPending, startTransition] = useTransition();
  const [storage, setStorage] = useState<Record<string, string>>({});
  const startedNavigating = useRef(false);

  useEffect(() => {
    getPersistentStorage()?.setItem(`${storageKey}/path-${path}`, "true");
    if (startedNavigating.current) {
      getPersistentStorage()?.setItem(`${storageKey}/lastIsPending`, String(isPending));
    }
    setStorage(readStorage(storageKey));
  }, [isPending, path, storageKey]);

  return (
    <>
      <button
        id="go"
        onClick={() => {
          const browserNavigation = readBrowserNavigation();
          getPersistentStorage()?.setItem(
            `${storageKey}/navigation-supported`,
            String(browserNavigation !== null),
          );
          if (!listening && browserNavigation !== null) {
            listening = true;
            browserNavigation.addEventListener("navigate", (event) => {
              const destinationUrl = event.destination?.url;
              if (!destinationUrl) return;
              const key = `${storageKey}/navigate-${destinationUrl}`;
              const storage = getPersistentStorage();
              if (storage === null) return;
              const current = Number(storage.getItem(key) ?? "0");
              storage.setItem(key, String(current + 1));
            });
          }

          startedNavigating.current = true;
          startTransition(() => {
            router.push("https://example.vercel.sh/stuff?abc=123");
          });
        }}
        type="button"
      >
        go
      </button>
      <pre id="storage">{JSON.stringify(storage, null, 2)}</pre>
    </>
  );
}
