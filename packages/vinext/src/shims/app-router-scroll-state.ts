export type AppRouterScrollIntent = Readonly<{
  commitId: number | null;
  hash: string | null;
  headElements: ReadonlySet<Element> | null;
  id: number;
  // Set by the committed `AppRouterScrollTarget` when this navigation's first
  // route DOM node was a React-hoisted resource in `<head>` (e.g. a
  // precedence-ordered stylesheet rendered as the page's first child). Next's
  // old App Router scroll handler gives up without scrolling in that case, so
  // the post-commit fallback in next/navigation must skip its document-top
  // scroll for THIS navigation only. The decision is per-intent on purpose: a
  // hoisted stylesheet merely *present* in `<head>` for unrelated navigations
  // must never suppress the fallback.
  targetHoistedInHead: boolean;
}>;

// A scroll intent is staged by `navigateClientSide` (next/navigation) before an
// RSC navigation and consumed by the committed `AppRouterScrollTarget`. Both run
// in the browser, but next/navigation and this module can be loaded through
// separate Vite module instances (see the Symbol.for navigation state in
// navigation.ts and AGENTS.md "RSC and SSR Are Separate Vite Environments"). If
// the writer and consumer held different module-level copies, the staged intent
// would be invisible to the consumer and scroll/focus would silently no-op.
// Store the single pending intent and the id counter on a Symbol.for global so
// every instance shares one slot, matching the rest of the navigation state.
const _SCROLL_INTENT_KEY = Symbol.for("vinext.appRouterScrollIntent");

type ScrollIntentStore = {
  nextId: number;
  pending: AppRouterScrollIntent | null;
};

type ScrollIntentGlobal = typeof globalThis & {
  [_SCROLL_INTENT_KEY]?: ScrollIntentStore;
};

function getScrollIntentStore(): ScrollIntentStore {
  const globalState = globalThis as ScrollIntentGlobal;
  globalState[_SCROLL_INTENT_KEY] ??= { nextId: 0, pending: null };
  return globalState[_SCROLL_INTENT_KEY]!;
}

export function beginAppRouterScrollIntent(hash: string | null): AppRouterScrollIntent {
  const store = getScrollIntentStore();
  store.nextId += 1;
  const intent = {
    commitId: null,
    hash,
    headElements: typeof document === "undefined" ? null : new Set(document.head?.children ?? []),
    id: store.nextId,
    targetHoistedInHead: false,
  };
  store.pending = intent;
  return intent;
}

export function clearAppRouterScrollIntent(): void {
  const store = getScrollIntentStore();
  // Clearing is itself a newer scroll decision (including `scroll: false`).
  // Advance ownership so deferred work from the prior intent cannot run after
  // the pending slot becomes empty.
  store.nextId += 1;
  store.pending = null;
}

export function getPendingAppRouterScrollIntent(): AppRouterScrollIntent | null {
  return getScrollIntentStore().pending;
}

// Deferred post-commit work must remain invalidatable after its intent has
// already been consumed. The monotonic id records newer ownership even when
// the newer intent is also consumed before the deferred callback runs.
export function isLatestAppRouterScrollIntent(
  expected: AppRouterScrollIntent | null | undefined,
): boolean {
  return (
    expected !== null && expected !== undefined && getScrollIntentStore().nextId === expected.id
  );
}

export function claimAppRouterScrollIntentForCommit(
  expected: AppRouterScrollIntent | null | undefined,
  commitId: number,
): void {
  const store = getScrollIntentStore();
  const intent = store.pending;
  if (expected === null || expected === undefined || intent === null) return;
  if (intent.id !== expected.id) return;

  store.pending = {
    ...intent,
    commitId,
  };
}

// Record that the committed scroll target for this navigation resolved to a
// React-hoisted node in `<head>`. Called by `AppRouterScrollTarget` instead of
// consuming the intent, so the next/navigation fallback can later read the flag
// and decline its document-top scroll for this navigation alone. Guarded by id
// and commitId so a stale or not-yet-claimed intent is never marked.
export function markAppRouterScrollIntentHeadHoisted(
  expected: AppRouterScrollIntent | null | undefined,
  commitId: number,
): void {
  const store = getScrollIntentStore();
  const intent = store.pending;
  if (expected === null || expected === undefined || intent === null) return;
  if (intent.id !== expected.id) return;
  if (intent.commitId !== commitId) return;

  store.pending = {
    ...intent,
    targetHoistedInHead: true,
  };
}

export function consumeAppRouterScrollIntent(
  expected: AppRouterScrollIntent | null | undefined,
  commitId?: number,
): AppRouterScrollIntent | null {
  if (expected === null || expected === undefined) return null;
  const store = getScrollIntentStore();
  const intent = store.pending;
  if (intent === null) return null;
  if (intent.id !== expected.id) return null;
  if (commitId !== undefined && intent.commitId !== commitId) return null;

  store.pending = null;
  return intent;
}
