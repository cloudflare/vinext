import type { AppProps } from "next/app";
import { useRouter } from "next/router";
import { useEffect } from "react";

const EVENT_LOG_KEY = "router-event-log";

declare global {
  interface Window {
    _clearEventLog(): void;
    _getEventLog(): unknown[][];
  }
}

function getEventLog(): unknown[][] {
  const data = sessionStorage.getItem(EVENT_LOG_KEY);
  return data ? JSON.parse(data) : [];
}

function addEvent(event: unknown[]) {
  sessionStorage.setItem(EVENT_LOG_KEY, JSON.stringify([...getEventLog(), event]));
}

if (typeof window !== "undefined") {
  window._clearEventLog = () => sessionStorage.removeItem(EVENT_LOG_KEY);
  window._getEventLog = getEventLog;
}

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();

  useEffect(() => {
    const onRouteChangeStart = (url: string, properties: { shallow: boolean }) =>
      addEvent(["routeChangeStart", url, properties]);
    const onBeforeHistoryChange = (url: string, properties: { shallow: boolean }) =>
      addEvent(["beforeHistoryChange", url, properties]);
    const onRouteChangeComplete = (url: string, properties: { shallow: boolean }) =>
      addEvent(["routeChangeComplete", url, properties]);
    const onRouteChangeError = (
      error: Error & { cancelled?: boolean },
      url: string,
      properties: { shallow: boolean },
    ) => addEvent(["routeChangeError", error.message, error.cancelled ?? null, url, properties]);
    const onHashChangeStart = (url: string, properties: { shallow: boolean }) =>
      addEvent(["hashChangeStart", url, properties]);
    const onHashChangeComplete = (url: string, properties: { shallow: boolean }) =>
      addEvent(["hashChangeComplete", url, properties]);

    router.events.on("routeChangeStart", onRouteChangeStart);
    router.events.on("beforeHistoryChange", onBeforeHistoryChange);
    router.events.on("routeChangeComplete", onRouteChangeComplete);
    router.events.on("routeChangeError", onRouteChangeError);
    router.events.on("hashChangeStart", onHashChangeStart);
    router.events.on("hashChangeComplete", onHashChangeComplete);

    return () => {
      router.events.off("routeChangeStart", onRouteChangeStart);
      router.events.off("beforeHistoryChange", onBeforeHistoryChange);
      router.events.off("routeChangeComplete", onRouteChangeComplete);
      router.events.off("routeChangeError", onRouteChangeError);
      router.events.off("hashChangeStart", onHashChangeStart);
      router.events.off("hashChangeComplete", onHashChangeComplete);
    };
  }, [router.events]);

  return <Component {...pageProps} />;
}
