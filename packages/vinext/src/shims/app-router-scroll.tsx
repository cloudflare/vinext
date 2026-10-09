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

function getScrollPaddingTopPx(element: HTMLElement, viewportHeight: number): number {
  const scrollPaddingTop = getComputedStyle(element).scrollPaddingTop;
  const value = Number.parseFloat(scrollPaddingTop);
  if (!Number.isFinite(value) || value < 0) return 0;
  if (scrollPaddingTop.endsWith("px")) return value;
  if (scrollPaddingTop.endsWith("%")) return (value / 100) * viewportHeight;
  return 0;
}

// The highest client rect of the route content decides whether it is already
// in the usable viewport, which starts below the root `scroll-padding-top`.
// The padding is resolved lazily so empty content never reads computed style.
function isTopInViewport(
  elements: readonly HTMLElement[],
  viewportHeight: number,
  getCurrentScrollPaddingTop: () => number,
): boolean {
  let elementTop = Number.POSITIVE_INFINITY;
  for (const element of elements) {
    for (const rect of element.getClientRects()) {
      if (rect.top < elementTop) {
        elementTop = rect.top;
      }
    }
  }

  return elementTop >= getCurrentScrollPaddingTop() && elementTop <= viewportHeight;
}

function getHashFragmentDomNode(hash: string): Element | null {
  const fragment = decodeHashFragment(hash.startsWith("#") ? hash.slice(1) : hash);
  if (fragment === "top") {
    return document.body;
  }

  return document.getElementById(fragment) ?? document.getElementsByName(fragment)[0] ?? null;
}

function isInDocumentHead(node: Element | Text): boolean {
  const head = node.ownerDocument?.head;
  return head != null && head.contains(node);
}

// React 19 stable has no Fragment refs, so the route content is located with
// findDOMNode() and its following siblings stand in for the Fragment's host
// children. Resources React hoists into <head> are never route content.
function collectRouteContentElements(node: Element | Text | null): HTMLElement[] {
  if (!(node instanceof Element) || isInDocumentHead(node)) {
    return [];
  }

  const elements: HTMLElement[] = [];
  for (let sibling: Element | null = node; sibling !== null; sibling = sibling.nextElementSibling) {
    if (sibling instanceof HTMLElement) {
      elements.push(sibling);
    }
  }
  return elements;
}

function hasBox(elements: readonly HTMLElement[]): boolean {
  return elements.some((element) => element.getClientRects().length > 0);
}

function scrollFirstBoxIntoView(elements: readonly HTMLElement[]): void {
  elements
    .find((element) => element.getClientRects().length > 0)
    ?.scrollIntoView({ behavior: "auto", block: "start", inline: "nearest" });
}

// Matches Next.js's default (new) App Router scroll handler: it scrolls only,
// never focuses, and treats `scroll-padding-top` as the viewport boundary.
function scrollToRouteContent(elements: readonly HTMLElement[]): void {
  const htmlElement = document.documentElement;
  const viewportHeight = htmlElement.clientHeight;
  let scrollPaddingTop: number | null = null;

  const getCurrentScrollPaddingTop = () => {
    scrollPaddingTop ??= getScrollPaddingTopPx(htmlElement, viewportHeight);
    return scrollPaddingTop;
  };

  if (isTopInViewport(elements, viewportHeight, getCurrentScrollPaddingTop)) {
    return;
  }

  htmlElement.scrollTop = 0;

  if (!isTopInViewport(elements, viewportHeight, getCurrentScrollPaddingTop)) {
    scrollFirstBoxIntoView(elements);
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
  scheduledCommitId: number | null = null;

  schedulePotentialScroll = () => {
    const commitId = this.props.commitId;
    this.scheduledCommitId = commitId;
    queueMicrotask(() => {
      if (this.scheduledCommitId !== commitId) return;
      this.handlePotentialScroll();
    });
  };

  handlePotentialScroll = () => {
    const intent = getPendingAppRouterScrollIntent();
    if (intent === null) return;
    if (this.props.commitId === null || intent.commitId !== this.props.commitId) return;

    if (intent.hash !== null) {
      // A hash target lives in the document, not in this segment, so any
      // committed segment may scroll it.
      const hashTarget = getHashFragmentDomNode(intent.hash);
      if (hashTarget !== null) {
        if (consumeAppRouterScrollIntent(intent, this.props.commitId) === null) return;
        hashTarget.scrollIntoView({ behavior: "auto" });
        return;
      }
    }

    if (intent.parallelSlotOwned) {
      // An intercepted route changed a parallel slot and left this segment as
      // it was. The slot owns the navigation's scroll signal, so consuming it
      // here keeps this retained page from scrolling or blurring and stops the
      // document-top fallback from doing so on the slot's behalf.
      consumeAppRouterScrollIntent(intent, this.props.commitId);
      return;
    }

    // oxlint-disable-next-line react/no-find-dom-node -- Next's default App Router scroll handler targets wrapperless route content after commit.
    const elements = collectRouteContentElements(findDOMNode(this));
    // Content without a box (display: none, empty, hoisted) is not a scroll
    // target: leave the intent for the document-top fallback.
    if (!hasBox(elements)) return;

    if (consumeAppRouterScrollIntent(intent, this.props.commitId) === null) return;

    if (intent.hash !== null) {
      // The hash is missing from the navigated page: scroll the segment itself.
      scrollFirstBoxIntoView(elements);
    } else {
      scrollToRouteContent(elements);
    }
  };

  componentDidMount() {
    this.schedulePotentialScroll();
  }

  componentDidUpdate() {
    this.schedulePotentialScroll();
  }

  componentWillUnmount() {
    this.scheduledCommitId = null;
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
