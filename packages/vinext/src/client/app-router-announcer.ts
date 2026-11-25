import { useEffect, useRef, useState } from "react";

// Ported from Next.js's App Router announcer
// (packages/next/src/client/components/app-router-announcer.tsx).
const ANNOUNCER_TYPE = "next-route-announcer";
const ANNOUNCER_ID = "__next-route-announcer__";

function getAnnouncerNode(): HTMLElement {
  const existingAnnouncer = document.getElementsByName(ANNOUNCER_TYPE)[0];
  if (existingAnnouncer?.shadowRoot?.childNodes[0]) {
    return existingAnnouncer.shadowRoot.childNodes[0] as HTMLElement;
  }
  const container = document.createElement(ANNOUNCER_TYPE);
  container.style.cssText = "position:absolute";
  const announcer = document.createElement("div");
  announcer.ariaLive = "assertive";
  announcer.id = ANNOUNCER_ID;
  announcer.role = "alert";
  announcer.style.cssText =
    "position:absolute;border:0;height:1px;margin:-1px;padding:0;width:1px;clip:rect(0 0 0 0);overflow:hidden;white-space:nowrap;word-wrap:normal";

  // Use shadow DOM here to avoid any potential CSS bleed
  const shadow = container.attachShadow({ mode: "open" });
  shadow.appendChild(announcer);
  document.body.appendChild(container);
  return announcer;
}

/**
 * Announces committed App Router navigations to screen readers. `tree` is the
 * committed route payload: the effect reruns once per commit that replaces it,
 * like Next.js keys it on the committed FlightRouterState.
 */
export function AppRouterAnnouncer({ tree }: { tree: unknown }) {
  const announcerNode = useRef<HTMLElement | null>(null);

  useEffect(() => {
    announcerNode.current = getAnnouncerNode();
    return () => {
      announcerNode.current = null;
      const container = document.getElementsByTagName(ANNOUNCER_TYPE)[0];
      if (container?.isConnected) {
        document.body.removeChild(container);
      }
    };
  }, []);

  const [routeAnnouncement, setRouteAnnouncement] = useState("");
  const previousTitle = useRef<string | undefined>(undefined);

  useEffect(() => {
    let currentTitle = "";
    if (document.title) {
      currentTitle = document.title;
    } else {
      const pageHeader = document.querySelector("h1");
      if (pageHeader) {
        currentTitle = pageHeader.innerText || pageHeader.textContent || "";
      }
    }

    // Only announce the title change, but not for the first load because screen
    // readers do that automatically.
    if (previousTitle.current !== undefined && previousTitle.current !== currentTitle) {
      setRouteAnnouncement(currentTitle);
    }
    previousTitle.current = currentTitle;
  }, [tree]);

  // Next.js portals the announcement into the region as a bare text node.
  // vinext writes the same text with textContent, so React owns no node there:
  // browser translation replaces that text node (vercel/next.js#99353), and
  // React would then update or remove a detached node, leaving the region
  // stale or throwing on removeChild. textContent replaces whatever the
  // translation left, and the region's markup stays the same as Next.js's.
  useEffect(() => {
    if (announcerNode.current) announcerNode.current.textContent = routeAnnouncement;
  }, [routeAnnouncement]);

  return null;
}
