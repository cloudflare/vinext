const ACTION_HTTP_FALLBACK_ROBOTS_META_ATTR = "data-vinext-action-http-fallback";

export function syncServerActionHttpFallbackHead(status: number | null): void {
  document.head
    .querySelectorAll(`meta[${ACTION_HTTP_FALLBACK_ROBOTS_META_ATTR}="robots"]`)
    .forEach((node) => node.remove());

  if (status !== 404) return;

  const robots = document.createElement("meta");
  robots.name = "robots";
  robots.content = "noindex";
  robots.setAttribute(ACTION_HTTP_FALLBACK_ROBOTS_META_ATTR, "robots");
  document.head.appendChild(robots);
}

/**
 * Wraps a navigation's committed-state callback so the action 404 noindex
 * marker is cleared only when that navigation's tree becomes visible. A
 * navigation that never commits leaves the marker with the tree still shown.
 */
export function clearActionHttpFallbackHeadOnCommit<State>(
  clearHead: () => void,
  onCommittedState?: (state: State) => void,
): (state: State) => void {
  return (state) => {
    clearHead();
    onCommittedState?.(state);
  };
}
