import { useEffect } from "react";
import { useRouter } from "next/router";

const eventLogKey = "basepath-router-events";

declare global {
  interface Window {
    __basePathRouterEvents: unknown[][];
  }
}

function useLoggedEvent(event: string, serializeArgs = (...args: unknown[]) => args) {
  const router = useRouter();
  useEffect(() => {
    const logEvent = (...args: unknown[]) => {
      const eventLog = JSON.parse(sessionStorage.getItem(eventLogKey) ?? "[]") as unknown[][];
      eventLog.push([event, ...serializeArgs(...args)]);
      sessionStorage.setItem(eventLogKey, JSON.stringify(eventLog));
      window.__basePathRouterEvents = eventLog;
    };
    router.events.on(event, logEvent);
    return () => router.events.off(event, logEvent);
  }, [event, router.events, serializeArgs]);
}

function serializeErrorEventArgs(
  error: Error & { cancelled?: boolean },
  url: string,
  properties: unknown,
) {
  return [error.message, error.cancelled, url, properties];
}

export default function App({ Component, pageProps }: any) {
  if (typeof window !== "undefined") {
    window.__basePathRouterEvents = JSON.parse(
      sessionStorage.getItem(eventLogKey) ?? "[]",
    ) as unknown[][];
  }
  useLoggedEvent("routeChangeStart");
  useLoggedEvent("routeChangeComplete");
  useLoggedEvent("routeChangeError", serializeErrorEventArgs as (...args: unknown[]) => unknown[]);
  useLoggedEvent("beforeHistoryChange");
  useLoggedEvent("hashChangeStart");
  useLoggedEvent("hashChangeComplete");
  return <Component {...pageProps} />;
}
