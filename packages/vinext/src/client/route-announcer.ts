import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Ported from Next.js's Pages Router announcer
// (packages/next/src/client/route-announcer.tsx) and the Portal that
// client/index.tsx mounts it in (packages/next/src/client/portal/index.tsx).

/**
 * Renders its children into a new `<type>` element appended to `<body>`. It
 * renders nothing on the server and during hydration, so the server and the
 * browser render the same tree.
 */
export function Portal({ children, type }: { children?: ReactNode; type: string }) {
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const element = document.createElement(type);
    document.body.appendChild(element);
    // oxlint-disable-next-line react/set-state-in-effect -- the portal host lives outside React's tree and only exists after mount
    setPortalNode(element);
    return () => {
      document.body.removeChild(element);
    };
  }, [type]);

  return portalNode ? createPortal(children, portalNode) : null;
}

const nextjsRouteAnnouncerStyles = {
  border: 0,
  clip: "rect(0 0 0 0)",
  height: "1px",
  margin: "-1px",
  overflow: "hidden",
  padding: 0,
  position: "absolute",
  top: 0,
  width: "1px",
  // https://medium.com/@jessebeach/beware-smushed-off-screen-accessible-text-5952a4c2cbfe
  whiteSpace: "nowrap",
  wordWrap: "normal",
} as const;

/**
 * Announces Pages Router navigations to screen readers. `asPath` is the
 * committed router's asPath, which Next.js reads from `useRouter()`.
 */
export function RouteAnnouncer({ asPath }: { asPath: string }) {
  const [routeAnnouncement, setRouteAnnouncement] = useState("");

  // Only announce the path change, but not for the first load because screen
  // reader will do that automatically.
  const previouslyLoadedPath = useRef(asPath);

  // Every time the path changes, announce the new page's title following this
  // priority: first the document title (from head), otherwise the first h1, or
  // if none of these exist, then the pathname from the URL. This methodology is
  // inspired by Marcy Sutton's accessible client routing user testing. More
  // information can be found here:
  // https://www.gatsbyjs.com/blog/2019-07-11-user-testing-accessible-client-routing/
  useEffect(() => {
    // If the path hasn't change, we do nothing.
    if (previouslyLoadedPath.current === asPath) return;
    previouslyLoadedPath.current = asPath;

    // Next.js's head manager sets document.title inside the new page's
    // passive effects, before this one runs. vinext's next/head applies it in
    // a microtask queued from those effects, so read the title in a microtask
    // queued after it.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (document.title) {
        setRouteAnnouncement(document.title);
      } else {
        const pageHeader = document.querySelector("h1");
        const content = pageHeader?.innerText ?? pageHeader?.textContent;
        setRouteAnnouncement(content || asPath);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [asPath]);

  return createElement(
    "p",
    {
      "aria-live": "assertive", // Make the announcement immediately.
      id: "__next-route-announcer__",
      role: "alert",
      style: nextjsRouteAnnouncerStyles,
    },
    routeAnnouncement,
  );
}

/**
 * The announcer as Next.js's client/index.tsx mounts it, registered by the
 * Pages client entry with `_registerPagesRouteAnnouncer` (next/router).
 */
export function PagesRouteAnnouncer({ asPath }: { asPath: string }) {
  return createElement(
    Portal,
    { type: "next-route-announcer" },
    createElement(RouteAnnouncer, { asPath }),
  );
}
