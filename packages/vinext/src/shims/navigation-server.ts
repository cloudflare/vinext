/**
 * Lightweight server-facing navigation facade.
 *
 * Keep this module limited to server-safe leaf modules. Importing the public
 * navigation shim here would reconnect RSC and SSR to the browser runtime.
 */

export {
  type NavigationContext,
  type NavigationStateAccessors,
  type SegmentMap,
  GLOBAL_ACCESSORS_KEY,
  ServerInsertedHTMLContext,
  _registerStateAccessors,
  clearClientHydrationContext,
  clearServerInsertedHTML,
  flushServerInsertedHTML,
  getBfcacheIdMapContext,
  getBfcacheSegmentIdContext,
  getLayoutSegmentContext,
  getNavigationContext,
  registerServerInsertedHTMLCallback,
  renderServerInsertedHTML,
  setNavigationContext,
} from "./navigation-context-state.js";

export {
  BailoutToCSRError,
  DynamicServerError,
  HTTP_ERROR_FALLBACK_ERROR_CODE,
  RedirectType,
  decodeRedirectError,
  forbidden,
  getAccessFallbackHTTPStatus,
  isBailoutToCSRError,
  isDynamicServerError,
  isHTTPAccessFallbackError,
  isNextRouterError,
  isRedirectError,
  notFound,
  permanentRedirect,
  redirect,
  unauthorized,
  unstable_rethrow,
} from "./navigation-errors.js";
