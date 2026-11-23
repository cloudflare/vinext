import { createElement, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const announcer = getAnnouncerNode();
    // oxlint-disable-next-line react/set-state-in-effect -- the portal host lives outside React's tree and only exists after mount
    setPortalNode(announcer);
    return () => {
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

  // A keyed element, not bare text (vercel/next.js#98314, for #99353): browser
  // translation replaces the text node, and React would then update or remove
  // a detached node, leaving the region stale or throwing on removeChild.
  // Changing the key replaces the whole span on every announcement. With
  // nothing to announce the region stays empty, as in Next.js.
  return portalNode
    ? createPortal(
        routeAnnouncement
          ? createElement("span", { key: routeAnnouncement }, routeAnnouncement)
          : null,
        portalNode,
      )
    : null;
}
