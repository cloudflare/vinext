"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const ANNOUNCER_TAG = "next-route-announcer";
const ANNOUNCER_ID = "__next-route-announcer__";

function getOrCreateAnnouncerNode(): HTMLElement {
  const existingHost = document.querySelector(ANNOUNCER_TAG);
  const existingNode = existingHost?.shadowRoot?.querySelector<HTMLElement>(`#${ANNOUNCER_ID}`);
  if (existingNode) return existingNode;

  const host = document.createElement(ANNOUNCER_TAG);
  host.style.position = "absolute";

  const announcer = document.createElement("div");
  announcer.id = ANNOUNCER_ID;
  announcer.setAttribute("aria-live", "assertive");
  announcer.setAttribute("role", "alert");
  announcer.style.cssText =
    "position:absolute;border:0;height:1px;margin:-1px;padding:0;width:1px;clip:rect(0 0 0 0);overflow:hidden;white-space:nowrap;word-wrap:normal";

  host.attachShadow({ mode: "open" }).appendChild(announcer);
  document.body.appendChild(host);
  return announcer;
}

function readRouteAnnouncement(): string {
  if (document.title) return document.title;

  const heading = document.querySelector("h1");
  return heading?.innerText || heading?.textContent || "";
}

/**
 * Re-evaluate the accessible route name after each approved visible commit.
 *
 * This signal is broader than soft navigation, so an announcement is written
 * only when the resulting title or heading changed. An aborted or superseded
 * render cannot advance the signal and announce a route the user never saw.
 * The first effect pass only records the initial name because the browser
 * already announces a full document load.
 */
export function AppRouterAnnouncer({ commitVersion }: { commitVersion: number }) {
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const [routeAnnouncement, setRouteAnnouncement] = useState("");
  const previousAnnouncement = useRef<string | undefined>(undefined);

  useEffect(() => {
    const announcer = getOrCreateAnnouncerNode();
    setPortalNode(announcer);

    return () => {
      const host = document.querySelector(ANNOUNCER_TAG);
      if (host?.isConnected) host.remove();
    };
  }, []);

  useEffect(() => {
    const currentAnnouncement = readRouteAnnouncement();
    if (
      previousAnnouncement.current !== undefined &&
      previousAnnouncement.current !== currentAnnouncement
    ) {
      setRouteAnnouncement(currentAnnouncement);
    }
    previousAnnouncement.current = currentAnnouncement;
  }, [commitVersion]);

  return portalNode ? createPortal(routeAnnouncement, portalNode) : null;
}
