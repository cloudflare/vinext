"use client";

import * as React from "react";
import * as ReactDOM from "react-dom";
import {
  consumeAppRouterScrollIntent,
  getPendingAppRouterScrollIntent,
} from "./app-router-scroll-state.js";
import { decodeHashFragment } from "./hash-scroll.js";

const AppRouterScrollCommitContext = React.createContext<number | null>(null);
const reactDomInternalsKey = "__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE";
const rectProperties = ["bottom", "height", "left", "right", "top", "width", "x", "y"] as const;

function readFindDOMNode(): ((instance: React.ReactInstance | null | undefined) => unknown) | null {
  const internals = Reflect.get(ReactDOM, reactDomInternalsKey);
  if (typeof internals !== "object" || internals === null) {
    return null;
  }

  const findDOMNode = Reflect.get(internals, "findDOMNode");
  return typeof findDOMNode === "function" ? findDOMNode : null;
}

function findDOMNode(instance: React.ReactInstance | null | undefined): Element | Text | null {
  if (typeof window === "undefined") return null;

  const findDOMNodeImpl = readFindDOMNode();
  if (!findDOMNodeImpl) return null;

  const node = findDOMNodeImpl(instance);
  return node instanceof Element || node instanceof Text ? node : null;
}

function shouldSkipElement(element: HTMLElement): boolean {
  const position = getComputedStyle(element).position;
  if (position === "fixed" || position === "sticky") {
    return true;
  }

  const rect = element.getBoundingClientRect();
  return rectProperties.every((property) => rect[property] === 0);
}

function topOfElementInViewport(element: HTMLElement, viewportHeight: number): boolean {
  const rects = element.getClientRects();
  if (rects.length === 0) {
    return false;
  }

  let elementTop = Number.POSITIVE_INFINITY;
  for (const rect of rects) {
    if (rect.top < elementTop) {
      elementTop = rect.top;
    }
  }

  return elementTop >= 0 && elementTop <= viewportHeight;
}

function getHashFragmentDomNode(hash: string): HTMLElement | null {
  const fragment = decodeHashFragment(hash.startsWith("#") ? hash.slice(1) : hash);
  if (fragment === "top") {
    return document.body;
  }

  const element = document.getElementById(fragment) ?? document.getElementsByName(fragment)[0];
  return element instanceof HTMLElement ? element : null;
}

function findNextScrollTarget(node: Element | Text | null): HTMLElement | null {
  if (!(node instanceof Element)) {
    return null;
  }

  let target: Element = node;
  while (!(target instanceof HTMLElement) || shouldSkipElement(target)) {
    if (target.nextElementSibling === null) {
      return null;
    }
    target = target.nextElementSibling;
  }

  return target;
}

function scrollToElement(target: HTMLElement, hash: string | null): void {
  if (hash !== null) {
    target.scrollIntoView({ behavior: "auto" });
    return;
  }

  const htmlElement = document.documentElement;
  const viewportHeight = htmlElement.clientHeight;

  if (topOfElementInViewport(target, viewportHeight)) {
    return;
  }

  htmlElement.scrollTop = 0;

  if (!topOfElementInViewport(target, viewportHeight)) {
    target.scrollIntoView({ behavior: "auto", block: "start", inline: "nearest" });
  }
}

// The inner component must stay a class: findDOMNode() needs a mounted
// class instance to locate the first DOM node rendered by the children
// without introducing a wrapper element. The outer AppRouterScrollTarget
// function component reads context and delegates here; only the inner
// class retains wrapperless targeting.
export class AppRouterScrollTargetInner extends React.Component<{
  children: React.ReactNode;
  commitId: number | null;
}> {
  handlePotentialScroll = () => {
    const intent = getPendingAppRouterScrollIntent();
    if (intent === null) return;
    if (this.props.commitId === null || intent.commitId !== this.props.commitId) return;

    let target: HTMLElement | null;
    if (intent.hash !== null) {
      target = getHashFragmentDomNode(intent.hash);
    } else {
      // oxlint-disable-next-line react/no-find-dom-node -- Next's default App Router scroll handler targets wrapperless route content after commit.
      target = findNextScrollTarget(findDOMNode(this));
    }
    if (target === null) return;

    const consumed = consumeAppRouterScrollIntent(intent, this.props.commitId);
    if (consumed === null) return;

    scrollToElement(target, consumed.hash);
    // Next's default handler uses plain focus(), but that lets the browser run
    // a second implicit scroll after our explicit navigation scroll. Keep the
    // focus transfer while preserving the scroll position we just chose.
    target.focus({ preventScroll: true });
  };

  componentDidMount() {
    this.handlePotentialScroll();
  }

  componentDidUpdate() {
    this.handlePotentialScroll();
  }

  render() {
    return this.props.children;
  }
}

export function AppRouterScrollCommitProvider({
  children,
  commitId,
}: {
  children?: React.ReactNode;
  commitId: number | null;
}) {
  return (
    <AppRouterScrollCommitContext.Provider value={commitId}>
      {children}
    </AppRouterScrollCommitContext.Provider>
  );
}

export function AppRouterScrollTarget({ children }: { children: React.ReactNode }) {
  const commitId = React.useContext(AppRouterScrollCommitContext);
  return <AppRouterScrollTargetInner commitId={commitId}>{children}</AppRouterScrollTargetInner>;
}
