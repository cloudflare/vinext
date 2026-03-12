import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import Link from "next/link";

const STORAGE_KEY = "router-events-log";

function getStoredEvents(): string[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function storeEvent(event: string) {
  const events = getStoredEvents();
  events.push(event);
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(events));
}

export default function RouterEventsTest() {
  const router = useRouter();
  const [events, setEvents] = useState<string[]>([]);

  // Load stored events on mount
  useEffect(() => {
    setEvents(getStoredEvents());
  }, []);

  useEffect(() => {
    const onStart = (url: string) => {
      storeEvent(`start:${url}`);
      setEvents(getStoredEvents());
    };
    const onComplete = (url: string) => {
      storeEvent(`complete:${url}`);
      setEvents(getStoredEvents());
    };
    const onError = (err: Error, url: string) => {
      storeEvent(`error:${url}:${err.message}`);
      setEvents(getStoredEvents());
    };

    const onBeforeHistoryChange = (url: string) => {
      storeEvent(`beforeHistoryChange:${url}`);
      setEvents(getStoredEvents());
    };
    const onHashStart = (url: string) => {
      storeEvent(`hashChangeStart:${url}`);
      setEvents(getStoredEvents());
    };
    const onHashComplete = (url: string) => {
      storeEvent(`hashChangeComplete:${url}`);
      setEvents(getStoredEvents());
    };

    router.events.on("routeChangeStart", onStart);
    router.events.on("routeChangeComplete", onComplete);
    router.events.on("routeChangeError", onError);
    router.events.on("beforeHistoryChange", onBeforeHistoryChange);
    router.events.on("hashChangeStart", onHashStart);
    router.events.on("hashChangeComplete", onHashComplete);

    return () => {
      router.events.off("routeChangeStart", onStart);
      router.events.off("routeChangeComplete", onComplete);
      router.events.off("routeChangeError", onError);
      router.events.off("beforeHistoryChange", onBeforeHistoryChange);
      router.events.off("hashChangeStart", onHashStart);
      router.events.off("hashChangeComplete", onHashComplete);
    };
  }, [router]);

  return (
    <div>
      <h1>Router Events Test</h1>
      <Link href="/about">
        <span data-testid="link-about">Go to About</span>
      </Link>
      <button data-testid="push-about" onClick={() => router.push("/about")}>
        Push About
      </button>
      <button data-testid="push-ssr" onClick={() => router.push("/ssr")}>
        Push SSR
      </button>
      <button data-testid="push-hash" onClick={() => router.push("#section-1")}>
        Push Hash
      </button>
      <button data-testid="replace-hash" onClick={() => router.replace("#section-2")}>
        Replace Hash
      </button>
      <button
        data-testid="clear-events"
        onClick={() => {
          sessionStorage.removeItem(STORAGE_KEY);
          setEvents([]);
        }}
      >
        Clear Events
      </button>
      <div data-testid="event-log">{events.join("|")}</div>
      <div data-testid="event-count">{events.length}</div>
    </div>
  );
}
