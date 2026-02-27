import React, { Children, isValidElement, useEffect, lazy, useState, Suspense, useCallback, useMemo, createContext, forwardRef, useRef } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { AsyncLocalStorage } from "node:async_hooks";
import { jsxDEV } from "react/jsx-dev-runtime";
let _ssrHeadElements = [];
let _getSSRHeadElements = () => _ssrHeadElements;
let _resetSSRHeadImpl = () => {
  _ssrHeadElements = [];
};
function _registerHeadStateAccessors(accessors) {
  _getSSRHeadElements = accessors.getSSRHeadElements;
  _resetSSRHeadImpl = accessors.resetSSRHead;
}
function resetSSRHead() {
  _resetSSRHeadImpl();
}
function getSSRHeadHTML() {
  return _getSSRHeadElements().join("\n  ");
}
const ALLOWED_HEAD_TAGS = /* @__PURE__ */ new Set([
  "title",
  "meta",
  "link",
  "style",
  "script",
  "base",
  "noscript"
]);
function reactElementToHTML(child) {
  const tag = child.type;
  if (!ALLOWED_HEAD_TAGS.has(tag)) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[vinext] <Head> ignoring disallowed tag <${tag}>. Only ${[...ALLOWED_HEAD_TAGS].join(", ")} are allowed.`
      );
    }
    return "";
  }
  const props = child.props;
  const attrs = [];
  let innerHTML = "";
  for (const [key, value] of Object.entries(props)) {
    if (key === "children") {
      if (typeof value === "string") {
        innerHTML = escapeHTML(value);
      }
    } else if (key === "dangerouslySetInnerHTML") {
      const html = value;
      if (html?.__html) innerHTML = html.__html;
    } else if (key === "className") {
      attrs.push(`class="${escapeAttr(String(value))}"`);
    } else if (typeof value === "string") {
      attrs.push(`${key}="${escapeAttr(value)}"`);
    } else if (typeof value === "boolean" && value) {
      attrs.push(key);
    }
  }
  const attrStr = attrs.length ? " " + attrs.join(" ") : "";
  const selfClosing = ["meta", "link", "base"];
  if (selfClosing.includes(tag)) {
    return `<${tag}${attrStr} data-vinext-head="true" />`;
  }
  return `<${tag}${attrStr} data-vinext-head="true">${innerHTML}</${tag}>`;
}
function escapeHTML(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function Head$1({ children }) {
  if (typeof window === "undefined") {
    Children.forEach(children, (child) => {
      if (!isValidElement(child)) return;
      if (typeof child.type !== "string") return;
      const html = reactElementToHTML(child);
      if (html) _getSSRHeadElements().push(html);
    });
    return null;
  }
  useEffect(() => {
    const elements = [];
    document.querySelectorAll("[data-vinext-head]").forEach((el) => el.remove());
    Children.forEach(children, (child) => {
      if (!isValidElement(child)) return;
      if (typeof child.type !== "string") return;
      if (!ALLOWED_HEAD_TAGS.has(child.type)) return;
      const domEl = document.createElement(child.type);
      const props = child.props;
      for (const [key, value] of Object.entries(props)) {
        if (key === "children" && typeof value === "string") {
          domEl.textContent = value;
        } else if (key === "dangerouslySetInnerHTML") ;
        else if (key === "className") {
          domEl.setAttribute("class", String(value));
        } else if (key !== "children" && typeof value === "string") {
          domEl.setAttribute(key, value);
        }
      }
      domEl.setAttribute("data-vinext-head", "true");
      document.head.appendChild(domEl);
      elements.push(domEl);
    });
    return () => {
      elements.forEach((el) => el.remove());
    };
  }, [children]);
  return null;
}
let DynamicErrorBoundary;
function getDynamicErrorBoundary() {
  if (DynamicErrorBoundary) return DynamicErrorBoundary;
  if (!React.Component) return null;
  DynamicErrorBoundary = class extends React.Component {
    constructor(props) {
      super(props);
      this.state = { error: null };
    }
    static getDerivedStateFromError(error) {
      return { error: error instanceof Error ? error : new Error(String(error)) };
    }
    render() {
      if (this.state.error) {
        return React.createElement(this.props.fallback, {
          isLoading: false,
          pastDelay: true,
          error: this.state.error
        });
      }
      return this.props.children;
    }
  };
  return DynamicErrorBoundary;
}
const isServer$1 = typeof window === "undefined";
const preloadQueue = [];
function flushPreloads() {
  const pending = preloadQueue.splice(0);
  return Promise.all(pending);
}
function dynamic(loader, options) {
  const { loading: LoadingComponent, ssr = true } = options ?? {};
  if (!ssr) {
    if (isServer$1) {
      const SSRFalse = (_props) => {
        return LoadingComponent ? React.createElement(LoadingComponent, { isLoading: true, pastDelay: true, error: null }) : null;
      };
      SSRFalse.displayName = "DynamicSSRFalse";
      return SSRFalse;
    }
    const LazyComponent2 = lazy(async () => {
      const mod = await loader();
      if ("default" in mod) return mod;
      return { default: mod };
    });
    const ClientSSRFalse = (props) => {
      const [mounted, setMounted] = useState(false);
      useEffect(() => setMounted(true), []);
      if (!mounted) {
        return LoadingComponent ? React.createElement(LoadingComponent, { isLoading: true, pastDelay: true, error: null }) : null;
      }
      const fallback = LoadingComponent ? React.createElement(LoadingComponent, { isLoading: true, pastDelay: true, error: null }) : null;
      return React.createElement(
        Suspense,
        { fallback },
        React.createElement(LazyComponent2, props)
      );
    };
    ClientSSRFalse.displayName = "DynamicClientSSRFalse";
    return ClientSSRFalse;
  }
  if (isServer$1) {
    const LazyServer = lazy(async () => {
      const mod = await loader();
      if ("default" in mod) return mod;
      return { default: mod };
    });
    const ServerDynamic = (props) => {
      const fallback = LoadingComponent ? React.createElement(LoadingComponent, { isLoading: true, pastDelay: true, error: null }) : null;
      const lazyElement = React.createElement(LazyServer, props);
      const ErrorBoundary = LoadingComponent ? getDynamicErrorBoundary() : null;
      const content = ErrorBoundary ? React.createElement(ErrorBoundary, { fallback: LoadingComponent }, lazyElement) : lazyElement;
      return React.createElement(Suspense, { fallback }, content);
    };
    ServerDynamic.displayName = "DynamicServer";
    return ServerDynamic;
  }
  const LazyComponent = lazy(async () => {
    const mod = await loader();
    if ("default" in mod) return mod;
    return { default: mod };
  });
  const ClientDynamic = (props) => {
    const fallback = LoadingComponent ? React.createElement(LoadingComponent, { isLoading: true, pastDelay: true, error: null }) : null;
    return React.createElement(
      Suspense,
      { fallback },
      React.createElement(LazyComponent, props)
    );
  };
  ClientDynamic.displayName = "DynamicClient";
  return ClientDynamic;
}
function isValidModulePath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (!p.startsWith("/") && !p.startsWith("./")) return false;
  if (p.startsWith("//")) return false;
  if (p.includes("://")) return false;
  if (p.includes("..")) return false;
  return true;
}
const __basePath = "";
function withBasePath$1(p) {
  return p;
}
function stripBasePath(p) {
  return p;
}
function createRouterEvents() {
  const listeners = /* @__PURE__ */ new Map();
  return {
    on(event, handler2) {
      if (!listeners.has(event)) listeners.set(event, /* @__PURE__ */ new Set());
      listeners.get(event).add(handler2);
    },
    off(event, handler2) {
      listeners.get(event)?.delete(handler2);
    },
    emit(event, ...args) {
      listeners.get(event)?.forEach((handler2) => handler2(...args));
    }
  };
}
const routerEvents = createRouterEvents();
function resolveUrl(url) {
  if (typeof url === "string") return url;
  let result = url.pathname ?? "/";
  if (url.query) {
    const params = new URLSearchParams(url.query);
    result += `?${params.toString()}`;
  }
  return result;
}
function applyNavigationLocale(url, locale) {
  if (!locale || typeof window === "undefined") return url;
  const defaultLocale = window.__VINEXT_DEFAULT_LOCALE__;
  if (locale === defaultLocale) return url;
  if (url.startsWith(`/${locale}/`) || url === `/${locale}`) return url;
  return `/${locale}${url.startsWith("/") ? url : `/${url}`}`;
}
function isExternalUrl(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}
function isHashOnlyChange$1(href) {
  if (href.startsWith("#")) return true;
  if (typeof window === "undefined") return false;
  try {
    const current = new URL(window.location.href);
    const next = new URL(href, window.location.href);
    return current.pathname === next.pathname && current.search === next.search && next.hash !== "";
  } catch {
    return false;
  }
}
function scrollToHash$1(hash) {
  if (!hash || hash === "#") {
    window.scrollTo(0, 0);
    return;
  }
  const el = document.getElementById(hash.slice(1));
  if (el) el.scrollIntoView({ behavior: "auto" });
}
function saveScrollPosition() {
  const state = window.history.state ?? {};
  window.history.replaceState(
    { ...state, __vinext_scrollX: window.scrollX, __vinext_scrollY: window.scrollY },
    ""
  );
}
function restoreScrollPosition$1(state) {
  if (state && typeof state === "object" && "__vinext_scrollY" in state) {
    const { __vinext_scrollX: x, __vinext_scrollY: y } = state;
    requestAnimationFrame(() => window.scrollTo(x, y));
  }
}
let _ssrContext = null;
let _getSSRContext = () => _ssrContext;
let _setSSRContextImpl = (ctx) => {
  _ssrContext = ctx;
};
function _registerRouterStateAccessors(accessors) {
  _getSSRContext = accessors.getSSRContext;
  _setSSRContextImpl = accessors.setSSRContext;
}
function setSSRContext(ctx) {
  _setSSRContextImpl(ctx);
}
function extractRouteParamNames(pattern) {
  const names = [];
  const bracketMatches = pattern.matchAll(/\[{1,2}(?:\.\.\.)?([\w-]+)\]{1,2}/g);
  for (const m of bracketMatches) {
    names.push(m[1]);
  }
  if (names.length > 0) return names;
  const colonMatches = pattern.matchAll(/:([\w-]+)[+*]?/g);
  for (const m of colonMatches) {
    names.push(m[1]);
  }
  return names;
}
function getPathnameAndQuery() {
  if (typeof window === "undefined") {
    const _ssrCtx = _getSSRContext();
    if (_ssrCtx) {
      const query2 = {};
      for (const [key, value] of Object.entries(_ssrCtx.query)) {
        query2[key] = Array.isArray(value) ? value.join(",") : value;
      }
      return { pathname: _ssrCtx.pathname, query: query2, asPath: _ssrCtx.asPath };
    }
    return { pathname: "/", query: {}, asPath: "/" };
  }
  const pathname = stripBasePath(window.location.pathname);
  const query = {};
  const nextData = window.__NEXT_DATA__;
  if (nextData && nextData.query && nextData.page) {
    const routeParamNames = extractRouteParamNames(nextData.page);
    for (const key of routeParamNames) {
      const value = nextData.query[key];
      if (typeof value === "string") {
        query[key] = value;
      } else if (Array.isArray(value)) {
        query[key] = value.join(",");
      }
    }
  }
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of params) {
    query[key] = value;
  }
  const asPath = pathname + window.location.search;
  return { pathname, query, asPath };
}
let _navInProgress = false;
async function navigateClient(url) {
  if (typeof window === "undefined") return;
  const win = window;
  const root = win.__VINEXT_ROOT__;
  if (!root) {
    window.location.href = url;
    return;
  }
  if (_navInProgress) return;
  _navInProgress = true;
  try {
    const res = await fetch(url, { headers: { Accept: "text/html" } });
    if (!res.ok) {
      window.location.href = url;
      return;
    }
    const html = await res.text();
    const match = html.match(/<script>window\.__NEXT_DATA__\s*=\s*(.*?)<\/script>/);
    if (!match) {
      window.location.href = url;
      return;
    }
    const nextData = JSON.parse(match[1]);
    const { pageProps } = nextData.props;
    win.__NEXT_DATA__ = nextData;
    let pageModuleUrl = nextData.__vinext?.pageModuleUrl;
    if (!pageModuleUrl) {
      const moduleMatch = html.match(/import\("([^"]+)"\);\s*\n\s*const PageComponent/);
      const altMatch = html.match(/await import\("([^"]+pages\/[^"]+)"\)/);
      pageModuleUrl = moduleMatch?.[1] ?? altMatch?.[1] ?? void 0;
    }
    if (!pageModuleUrl) {
      window.location.href = url;
      return;
    }
    if (!isValidModulePath(pageModuleUrl)) {
      console.error("[vinext] Blocked import of invalid page module path:", pageModuleUrl);
      window.location.href = url;
      return;
    }
    const pageModule = await import(
      /* @vite-ignore */
      pageModuleUrl
    );
    const PageComponent = pageModule.default;
    if (!PageComponent) {
      window.location.href = url;
      return;
    }
    const React2 = (await import("react")).default;
    let AppComponent = win.__VINEXT_APP__;
    const appModuleUrl = nextData.__vinext?.appModuleUrl;
    if (!AppComponent && appModuleUrl) {
      if (!isValidModulePath(appModuleUrl)) {
        console.error("[vinext] Blocked import of invalid app module path:", appModuleUrl);
      } else {
        try {
          const appModule = await import(
            /* @vite-ignore */
            appModuleUrl
          );
          AppComponent = appModule.default;
          win.__VINEXT_APP__ = AppComponent;
        } catch {
        }
      }
    }
    let element;
    if (AppComponent) {
      element = React2.createElement(AppComponent, {
        Component: PageComponent,
        pageProps
      });
    } else {
      element = React2.createElement(PageComponent, pageProps);
    }
    root.render(element);
  } catch (err) {
    console.error("[vinext] Client navigation failed:", err);
    routerEvents.emit("routeChangeError", err, url);
    window.location.href = url;
  } finally {
    _navInProgress = false;
  }
}
function useRouter() {
  const [{ pathname, query, asPath }, setState] = useState(getPathnameAndQuery);
  useEffect(() => {
    const onPopState = (e) => {
      setState(getPathnameAndQuery());
      navigateClient(window.location.pathname + window.location.search).then(() => {
        restoreScrollPosition$1(e.state);
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    const onNavigate = ((_e) => {
      setState(getPathnameAndQuery());
    });
    window.addEventListener("vinext:navigate", onNavigate);
    return () => window.removeEventListener("vinext:navigate", onNavigate);
  }, []);
  const push = useCallback(
    async (url, _as, options) => {
      const resolved = applyNavigationLocale(resolveUrl(url), options?.locale);
      if (isExternalUrl(resolved)) {
        window.location.assign(resolved);
        return true;
      }
      if (isHashOnlyChange$1(resolved)) {
        const hash2 = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
        window.history.pushState({}, "", resolved.startsWith("#") ? resolved : withBasePath$1(resolved));
        scrollToHash$1(hash2);
        setState(getPathnameAndQuery());
        window.dispatchEvent(new CustomEvent("vinext:navigate"));
        return true;
      }
      saveScrollPosition();
      const full = withBasePath$1(resolved);
      routerEvents.emit("routeChangeStart", resolved);
      window.history.pushState({}, "", full);
      if (!options?.shallow) {
        await navigateClient(full);
      }
      setState(getPathnameAndQuery());
      routerEvents.emit("routeChangeComplete", resolved);
      const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
      if (hash) {
        scrollToHash$1(hash);
      } else if (options?.scroll !== false) {
        window.scrollTo(0, 0);
      }
      window.dispatchEvent(new CustomEvent("vinext:navigate"));
      return true;
    },
    []
  );
  const replace = useCallback(
    async (url, _as, options) => {
      const resolved = applyNavigationLocale(resolveUrl(url), options?.locale);
      if (isExternalUrl(resolved)) {
        window.location.replace(resolved);
        return true;
      }
      if (isHashOnlyChange$1(resolved)) {
        const hash2 = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
        window.history.replaceState({}, "", resolved.startsWith("#") ? resolved : withBasePath$1(resolved));
        scrollToHash$1(hash2);
        setState(getPathnameAndQuery());
        window.dispatchEvent(new CustomEvent("vinext:navigate"));
        return true;
      }
      const full = withBasePath$1(resolved);
      routerEvents.emit("routeChangeStart", resolved);
      window.history.replaceState({}, "", full);
      if (!options?.shallow) {
        await navigateClient(full);
      }
      setState(getPathnameAndQuery());
      routerEvents.emit("routeChangeComplete", resolved);
      const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
      if (hash) {
        scrollToHash$1(hash);
      } else if (options?.scroll !== false) {
        window.scrollTo(0, 0);
      }
      window.dispatchEvent(new CustomEvent("vinext:navigate"));
      return true;
    },
    []
  );
  const back = useCallback(() => {
    window.history.back();
  }, []);
  const reload = useCallback(() => {
    window.location.reload();
  }, []);
  const prefetch = useCallback(async (url) => {
    if (typeof document !== "undefined") {
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = url;
      link.as = "document";
      document.head.appendChild(link);
    }
  }, []);
  const _ssrState = _getSSRContext();
  const locale = typeof window === "undefined" ? _ssrState?.locale : window.__VINEXT_LOCALE__;
  const locales = typeof window === "undefined" ? _ssrState?.locales : window.__VINEXT_LOCALES__;
  const defaultLocale = typeof window === "undefined" ? _ssrState?.defaultLocale : window.__VINEXT_DEFAULT_LOCALE__;
  const route = typeof window !== "undefined" ? window.__NEXT_DATA__?.page ?? pathname : pathname;
  const router2 = useMemo(
    () => ({
      pathname,
      route,
      query,
      asPath,
      basePath: __basePath,
      locale,
      locales,
      defaultLocale,
      isReady: true,
      isPreview: false,
      isFallback: typeof window !== "undefined" && window.__NEXT_DATA__?.isFallback === true,
      push,
      replace,
      back,
      reload,
      prefetch,
      beforePopState: (cb) => {
        _beforePopStateCb = cb;
      },
      events: routerEvents
    }),
    [pathname, query, asPath, locale, locales, defaultLocale, push, replace, back, reload, prefetch, route]
  );
  return router2;
}
let _beforePopStateCb;
if (typeof window !== "undefined") {
  window.addEventListener("popstate", (e) => {
    const browserUrl = window.location.pathname + window.location.search;
    const appUrl = stripBasePath(window.location.pathname) + window.location.search;
    if (_beforePopStateCb !== void 0) {
      const shouldContinue = _beforePopStateCb({ url: appUrl, as: appUrl, options: { shallow: false } });
      if (!shouldContinue) return;
    }
    routerEvents.emit("routeChangeStart", appUrl);
    navigateClient(browserUrl).then(() => {
      routerEvents.emit("routeChangeComplete", appUrl);
      restoreScrollPosition$1(e.state);
      window.dispatchEvent(new CustomEvent("vinext:navigate"));
    });
  });
}
const Router = {
  push: async (url, _as, options) => {
    const resolved = applyNavigationLocale(resolveUrl(url), options?.locale);
    if (isExternalUrl(resolved)) {
      window.location.assign(resolved);
      return true;
    }
    if (isHashOnlyChange$1(resolved)) {
      const hash2 = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
      window.history.pushState({}, "", resolved.startsWith("#") ? resolved : withBasePath$1(resolved));
      scrollToHash$1(hash2);
      window.dispatchEvent(new CustomEvent("vinext:navigate"));
      return true;
    }
    saveScrollPosition();
    const full = withBasePath$1(resolved);
    routerEvents.emit("routeChangeStart", resolved);
    window.history.pushState({}, "", full);
    if (!options?.shallow) {
      await navigateClient(full);
    }
    routerEvents.emit("routeChangeComplete", resolved);
    const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
    if (hash) {
      scrollToHash$1(hash);
    } else if (options?.scroll !== false) {
      window.scrollTo(0, 0);
    }
    window.dispatchEvent(new CustomEvent("vinext:navigate"));
    return true;
  },
  replace: async (url, _as, options) => {
    const resolved = applyNavigationLocale(resolveUrl(url), options?.locale);
    if (isExternalUrl(resolved)) {
      window.location.replace(resolved);
      return true;
    }
    if (isHashOnlyChange$1(resolved)) {
      const hash2 = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
      window.history.replaceState({}, "", resolved.startsWith("#") ? resolved : withBasePath$1(resolved));
      scrollToHash$1(hash2);
      window.dispatchEvent(new CustomEvent("vinext:navigate"));
      return true;
    }
    const full = withBasePath$1(resolved);
    routerEvents.emit("routeChangeStart", resolved);
    window.history.replaceState({}, "", full);
    if (!options?.shallow) {
      await navigateClient(full);
    }
    routerEvents.emit("routeChangeComplete", resolved);
    const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
    if (hash) {
      scrollToHash$1(hash);
    } else if (options?.scroll !== false) {
      window.scrollTo(0, 0);
    }
    window.dispatchEvent(new CustomEvent("vinext:navigate"));
    return true;
  },
  back: () => window.history.back(),
  reload: () => window.location.reload(),
  prefetch: async (url) => {
    if (typeof document !== "undefined") {
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = url;
      link.as = "document";
      document.head.appendChild(link);
    }
  },
  beforePopState: (cb) => {
    _beforePopStateCb = cb;
  },
  events: routerEvents
};
const router = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  _registerRouterStateAccessors,
  applyNavigationLocale,
  default: Router,
  isExternalUrl,
  isHashOnlyChange: isHashOnlyChange$1,
  setSSRContext,
  useRouter
}, Symbol.toStringTag, { value: "Module" }));
const _ALS_KEY$4 = /* @__PURE__ */ Symbol.for("vinext.nextHeadersShim.als");
const _FALLBACK_KEY$4 = /* @__PURE__ */ Symbol.for("vinext.nextHeadersShim.fallback");
const _g$5 = globalThis;
_g$5[_ALS_KEY$4] ??= new AsyncLocalStorage();
_g$5[_FALLBACK_KEY$4] ??= {
  headersContext: null,
  dynamicUsageDetected: false,
  pendingSetCookies: [],
  draftModeCookieHeader: null
};
class MemoryCacheHandler {
  store = /* @__PURE__ */ new Map();
  tagRevalidatedAt = /* @__PURE__ */ new Map();
  async get(key, _ctx) {
    const entry = this.store.get(key);
    if (!entry) return null;
    for (const tag of entry.tags) {
      const revalidatedAt = this.tagRevalidatedAt.get(tag);
      if (revalidatedAt && revalidatedAt >= entry.lastModified) {
        this.store.delete(key);
        return null;
      }
    }
    if (entry.revalidateAt !== null && Date.now() > entry.revalidateAt) {
      return {
        lastModified: entry.lastModified,
        value: entry.value,
        cacheState: "stale"
      };
    }
    return {
      lastModified: entry.lastModified,
      value: entry.value
    };
  }
  async set(key, data, ctx) {
    const tags = [];
    if (data && "tags" in data && Array.isArray(data.tags)) {
      tags.push(...data.tags);
    }
    if (ctx && "tags" in ctx && Array.isArray(ctx.tags)) {
      tags.push(...ctx.tags);
    }
    let revalidateAt = null;
    if (ctx) {
      const revalidate = ctx.cacheControl?.revalidate ?? ctx.revalidate;
      if (typeof revalidate === "number" && revalidate > 0) {
        revalidateAt = Date.now() + revalidate * 1e3;
      }
    }
    if (data && "revalidate" in data && typeof data.revalidate === "number") {
      revalidateAt = Date.now() + data.revalidate * 1e3;
    }
    this.store.set(key, {
      value: data,
      tags,
      lastModified: Date.now(),
      revalidateAt
    });
  }
  async revalidateTag(tags, _durations) {
    const tagList = Array.isArray(tags) ? tags : [tags];
    const now = Date.now();
    for (const tag of tagList) {
      this.tagRevalidatedAt.set(tag, now);
    }
  }
  resetRequestCache() {
  }
}
let activeHandler = new MemoryCacheHandler();
function getCacheHandler() {
  return activeHandler;
}
const _ALS_KEY$3 = /* @__PURE__ */ Symbol.for("vinext.cache.als");
const _FALLBACK_KEY$3 = /* @__PURE__ */ Symbol.for("vinext.cache.fallback");
const _g$4 = globalThis;
const _cacheAls = _g$4[_ALS_KEY$3] ??= new AsyncLocalStorage();
_g$4[_FALLBACK_KEY$3] ??= {
  requestScopedCacheLife: null
};
function _runWithCacheState(fn) {
  const state = {
    requestScopedCacheLife: null
  };
  return _cacheAls.run(state, fn);
}
const HEADER_BLOCKLIST = ["traceparent", "tracestate"];
const CACHE_KEY_PREFIX = "v1";
function collectHeaders(input, init) {
  const merged = {};
  if (input instanceof Request && input.headers) {
    input.headers.forEach((v, k) => {
      merged[k] = v;
    });
  }
  if (init?.headers) {
    const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
    headers.forEach((v, k) => {
      merged[k] = v;
    });
  }
  for (const blocked of HEADER_BLOCKLIST) {
    delete merged[blocked];
  }
  return merged;
}
const AUTH_HEADERS = ["authorization", "cookie", "x-api-key"];
function hasAuthHeaders(input, init) {
  const headers = collectHeaders(input, init);
  return AUTH_HEADERS.some((name) => name in headers);
}
async function serializeBody(init) {
  if (!init?.body) return [];
  const bodyChunks = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  if (init.body instanceof Uint8Array) {
    bodyChunks.push(decoder.decode(init.body));
    init._ogBody = init.body;
  } else if (typeof init.body.getReader === "function") {
    const readableBody = init.body;
    const chunks = [];
    try {
      await readableBody.pipeTo(
        new WritableStream({
          write(chunk) {
            if (typeof chunk === "string") {
              chunks.push(encoder.encode(chunk));
              bodyChunks.push(chunk);
            } else {
              chunks.push(chunk);
              bodyChunks.push(decoder.decode(chunk, { stream: true }));
            }
          }
        })
      );
      bodyChunks.push(decoder.decode());
      const length = chunks.reduce((total, arr) => total + arr.length, 0);
      const arrayBuffer = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        arrayBuffer.set(chunk, offset);
        offset += chunk.length;
      }
      init._ogBody = arrayBuffer;
    } catch (err) {
      console.error("[vinext] Problem reading body for cache key", err);
      if (chunks.length > 0) {
        const length = chunks.reduce((total, arr) => total + arr.length, 0);
        const partial = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          partial.set(chunk, offset);
          offset += chunk.length;
        }
        init._ogBody = partial;
      }
    }
  } else if (init.body instanceof URLSearchParams) {
    init._ogBody = init.body;
    bodyChunks.push(init.body.toString());
  } else if (typeof init.body.keys === "function") {
    const formData = init.body;
    init._ogBody = init.body;
    for (const key of new Set(formData.keys())) {
      const values = formData.getAll(key);
      bodyChunks.push(
        `${key}=${(await Promise.all(
          values.map(async (val) => {
            if (typeof val === "string") return val;
            return await val.text();
          })
        )).join(",")}`
      );
    }
  } else if (typeof init.body.arrayBuffer === "function") {
    const blob = init.body;
    bodyChunks.push(await blob.text());
    const arrayBuffer = await blob.arrayBuffer();
    init._ogBody = new Blob([arrayBuffer], { type: blob.type });
  } else if (typeof init.body === "string") {
    bodyChunks.push(init.body);
    init._ogBody = init.body;
  }
  return bodyChunks;
}
async function buildFetchCacheKey(input, init) {
  let url;
  let method = "GET";
  if (typeof input === "string") {
    url = input;
  } else if (input instanceof URL) {
    url = input.toString();
  } else {
    url = input.url;
    method = input.method || "GET";
  }
  if (init?.method) method = init.method;
  const headers = collectHeaders(input, init);
  const bodyChunks = await serializeBody(init);
  const cacheString = JSON.stringify([
    CACHE_KEY_PREFIX,
    url,
    method,
    headers,
    init?.mode,
    init?.redirect,
    init?.credentials,
    init?.referrer,
    init?.referrerPolicy,
    init?.integrity,
    init?.cache,
    bodyChunks
  ]);
  const encoder = new TextEncoder();
  const buffer = encoder.encode(cacheString);
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.prototype.map.call(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, "0")).join("");
}
const _ORIG_FETCH_KEY = /* @__PURE__ */ Symbol.for("vinext.fetchCache.originalFetch");
const _gFetch = globalThis;
const originalFetch = _gFetch[_ORIG_FETCH_KEY] ??= globalThis.fetch;
const _ALS_KEY$2 = /* @__PURE__ */ Symbol.for("vinext.fetchCache.als");
const _FALLBACK_KEY$2 = /* @__PURE__ */ Symbol.for("vinext.fetchCache.fallback");
const _g$3 = globalThis;
const _als$2 = _g$3[_ALS_KEY$2] ??= new AsyncLocalStorage();
const _fallbackState$2 = _g$3[_FALLBACK_KEY$2] ??= {
  currentRequestTags: []
};
function _getState$2() {
  return _als$2.getStore() ?? _fallbackState$2;
}
function createPatchedFetch() {
  return async function patchedFetch(input, init) {
    const nextOpts = init?.next;
    const cacheDirective = init?.cache;
    if (!nextOpts && !cacheDirective) {
      return originalFetch(input, init);
    }
    if (cacheDirective === "no-store" || cacheDirective === "no-cache" || nextOpts?.revalidate === false || nextOpts?.revalidate === 0) {
      const cleanInit2 = stripNextFromInit(init);
      return originalFetch(input, cleanInit2);
    }
    const hasExplicitCacheOpt = cacheDirective === "force-cache" || typeof nextOpts?.revalidate === "number" && nextOpts.revalidate > 0;
    if (!hasExplicitCacheOpt && hasAuthHeaders(input, init)) {
      const cleanInit2 = stripNextFromInit(init);
      return originalFetch(input, cleanInit2);
    }
    let revalidateSeconds;
    if (cacheDirective === "force-cache") {
      revalidateSeconds = nextOpts?.revalidate && typeof nextOpts.revalidate === "number" ? nextOpts.revalidate : 31536e3;
    } else if (typeof nextOpts?.revalidate === "number" && nextOpts.revalidate > 0) {
      revalidateSeconds = nextOpts.revalidate;
    } else {
      if (nextOpts?.tags && nextOpts.tags.length > 0) {
        revalidateSeconds = 31536e3;
      } else {
        const cleanInit2 = stripNextFromInit(init);
        return originalFetch(input, cleanInit2);
      }
    }
    const tags = nextOpts?.tags ?? [];
    const cacheKey = await buildFetchCacheKey(input, init);
    const handler2 = getCacheHandler();
    const reqTags = _getState$2().currentRequestTags;
    if (tags.length > 0) {
      for (const tag of tags) {
        if (!reqTags.includes(tag)) {
          reqTags.push(tag);
        }
      }
    }
    try {
      const cached = await handler2.get(cacheKey, { kind: "FETCH", tags });
      if (cached?.value && cached.value.kind === "FETCH" && cached.cacheState !== "stale") {
        const cachedData = cached.value.data;
        return new Response(cachedData.body, {
          status: cachedData.status ?? 200,
          headers: cachedData.headers
        });
      }
      if (cached?.value && cached.value.kind === "FETCH" && cached.cacheState === "stale") {
        const staleData = cached.value.data;
        const cleanInit2 = stripNextFromInit(init);
        originalFetch(input, cleanInit2).then(async (freshResp) => {
          const freshBody = await freshResp.text();
          const freshHeaders = {};
          freshResp.headers.forEach((v, k) => {
            freshHeaders[k] = v;
          });
          const freshValue = {
            kind: "FETCH",
            data: {
              headers: freshHeaders,
              body: freshBody,
              url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
              status: freshResp.status
            },
            tags,
            revalidate: revalidateSeconds
          };
          await handler2.set(cacheKey, freshValue, {
            fetchCache: true,
            tags,
            revalidate: revalidateSeconds
          });
        }).catch((err) => {
          console.error("[vinext] fetch cache background revalidation failed:", err);
        });
        return new Response(staleData.body, {
          status: staleData.status ?? 200,
          headers: staleData.headers
        });
      }
    } catch (cacheErr) {
      console.error("[vinext] fetch cache read error:", cacheErr);
    }
    const cleanInit = stripNextFromInit(init);
    const response = await originalFetch(input, cleanInit);
    if (response.ok) {
      const cloned = response.clone();
      const body = await cloned.text();
      const headers = {};
      cloned.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const cacheValue = {
        kind: "FETCH",
        data: {
          headers,
          body,
          url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
          status: cloned.status
        },
        tags,
        revalidate: revalidateSeconds
      };
      handler2.set(cacheKey, cacheValue, {
        fetchCache: true,
        tags,
        revalidate: revalidateSeconds
      }).catch((err) => {
        console.error("[vinext] fetch cache write error:", err);
      });
    }
    return response;
  };
}
function stripNextFromInit(init) {
  if (!init) return init;
  const castInit = init;
  const { next: _next, _ogBody, ...rest } = castInit;
  if (_ogBody !== void 0) {
    rest.body = _ogBody;
  }
  return Object.keys(rest).length > 0 ? rest : void 0;
}
const _PATCH_KEY = /* @__PURE__ */ Symbol.for("vinext.fetchCache.patchInstalled");
function _ensurePatchInstalled() {
  if (_g$3[_PATCH_KEY]) return;
  _g$3[_PATCH_KEY] = true;
  globalThis.fetch = createPatchedFetch();
}
async function runWithFetchCache(fn) {
  _ensurePatchInstalled();
  return _als$2.run({ currentRequestTags: [] }, fn);
}
new AsyncLocalStorage();
const _PRIVATE_ALS_KEY = /* @__PURE__ */ Symbol.for("vinext.cacheRuntime.privateAls");
const _PRIVATE_FALLBACK_KEY = /* @__PURE__ */ Symbol.for("vinext.cacheRuntime.privateFallback");
const _g$2 = globalThis;
const _privateAls = _g$2[_PRIVATE_ALS_KEY] ??= new AsyncLocalStorage();
_g$2[_PRIVATE_FALLBACK_KEY] ??= {
  cache: /* @__PURE__ */ new Map()
};
function runWithPrivateCache(fn) {
  const state = {
    cache: /* @__PURE__ */ new Map()
  };
  return _privateAls.run(state, fn);
}
const _ALS_KEY$1 = /* @__PURE__ */ Symbol.for("vinext.router.als");
const _FALLBACK_KEY$1 = /* @__PURE__ */ Symbol.for("vinext.router.fallback");
const _g$1 = globalThis;
const _als$1 = _g$1[_ALS_KEY$1] ??= new AsyncLocalStorage();
const _fallbackState$1 = _g$1[_FALLBACK_KEY$1] ??= {
  ssrContext: null
};
function _getState$1() {
  return _als$1.getStore() ?? _fallbackState$1;
}
function runWithRouterState(fn) {
  const state = {
    ssrContext: null
  };
  return _als$1.run(state, fn);
}
_registerRouterStateAccessors({
  getSSRContext() {
    return _getState$1().ssrContext;
  },
  setSSRContext(ctx) {
    const state = _als$1.getStore();
    if (state) {
      state.ssrContext = ctx;
    } else {
      _fallbackState$1.ssrContext = ctx;
    }
  }
});
const _ALS_KEY = /* @__PURE__ */ Symbol.for("vinext.head.als");
const _FALLBACK_KEY = /* @__PURE__ */ Symbol.for("vinext.head.fallback");
const _g = globalThis;
const _als = _g[_ALS_KEY] ??= new AsyncLocalStorage();
const _fallbackState = _g[_FALLBACK_KEY] ??= {
  ssrHeadElements: []
};
function _getState() {
  return _als.getStore() ?? _fallbackState;
}
function runWithHeadState(fn) {
  const state = {
    ssrHeadElements: []
  };
  return _als.run(state, fn);
}
_registerHeadStateAccessors({
  getSSRHeadElements() {
    return _getState().ssrHeadElements;
  },
  resetSSRHead() {
    const state = _als.getStore();
    if (state) {
      state.ssrHeadElements = [];
    } else {
      _fallbackState.ssrHeadElements = [];
    }
  }
});
function safeJsonStringify(data) {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function escapeCSSString(value) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\a ").replace(/\r/g, "\\d ");
}
function sanitizeCSSVarName(name) {
  if (/^--[a-zA-Z0-9_-]+$/.test(name)) return name;
  return void 0;
}
function sanitizeFallback(name) {
  const generics = /* @__PURE__ */ new Set([
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "emoji",
    "math",
    "fangsong"
  ]);
  const trimmed = name.trim();
  if (generics.has(trimmed)) return trimmed;
  return `'${escapeCSSString(trimmed)}'`;
}
let classCounter = 0;
const injectedFonts = /* @__PURE__ */ new Set();
function toVarName(family) {
  return "--font-" + family.toLowerCase().replace(/\s+/g, "-");
}
function buildGoogleFontsUrl(family, options) {
  const params = new URLSearchParams();
  let spec = family;
  const weights = options.weight ? Array.isArray(options.weight) ? options.weight : [options.weight] : [];
  const styles = options.style ? Array.isArray(options.style) ? options.style : [options.style] : [];
  if (weights.length > 0 || styles.length > 0) {
    const hasItalic = styles.includes("italic");
    if (weights.length > 0) {
      if (hasItalic) {
        const pairs = [];
        for (const w of weights) {
          pairs.push(`0,${w}`);
          pairs.push(`1,${w}`);
        }
        spec += `:ital,wght@${pairs.join(";")}`;
      } else {
        spec += `:wght@${weights.join(";")}`;
      }
    }
  } else {
    spec += `:wght@100..900`;
  }
  params.set("family", spec);
  params.set("display", options.display ?? "swap");
  return `https://fonts.googleapis.com/css2?${params.toString()}`;
}
function injectFontStylesheet(url) {
  if (injectedFonts.has(url)) return;
  injectedFonts.add(url);
  if (typeof document !== "undefined") {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    document.head.appendChild(link);
  }
}
const injectedClassRules = /* @__PURE__ */ new Set();
function injectClassNameRule(className, fontFamily) {
  if (injectedClassRules.has(className)) return;
  injectedClassRules.add(className);
  const css = `.${className} { font-family: ${fontFamily}; }
`;
  if (typeof document === "undefined") {
    ssrFontStyles$1.push(css);
    return;
  }
  const style = document.createElement("style");
  style.textContent = css;
  style.setAttribute("data-vinext-font-class", className);
  document.head.appendChild(style);
}
const injectedVariableRules = /* @__PURE__ */ new Set();
const injectedRootVariables = /* @__PURE__ */ new Set();
function injectVariableClassRule(variableClassName, cssVarName, fontFamily) {
  if (injectedVariableRules.has(variableClassName)) return;
  injectedVariableRules.add(variableClassName);
  let css = `.${variableClassName} { ${cssVarName}: ${fontFamily}; }
`;
  if (!injectedRootVariables.has(cssVarName)) {
    injectedRootVariables.add(cssVarName);
    css += `:root { ${cssVarName}: ${fontFamily}; }
`;
  }
  if (typeof document === "undefined") {
    ssrFontStyles$1.push(css);
    return;
  }
  const style = document.createElement("style");
  style.textContent = css;
  style.setAttribute("data-vinext-font-variable", variableClassName);
  document.head.appendChild(style);
}
const ssrFontStyles$1 = [];
function getSSRFontStyles$1() {
  return [...ssrFontStyles$1];
}
const ssrFontUrls = [];
function getSSRFontLinks() {
  return [...ssrFontUrls];
}
const ssrFontPreloads$1 = [];
const ssrFontPreloadHrefs = /* @__PURE__ */ new Set();
function getSSRFontPreloads$1() {
  return [...ssrFontPreloads$1];
}
function getFontMimeType(pathOrUrl) {
  if (pathOrUrl.endsWith(".woff2")) return "font/woff2";
  if (pathOrUrl.endsWith(".woff")) return "font/woff";
  if (pathOrUrl.endsWith(".ttf")) return "font/ttf";
  if (pathOrUrl.endsWith(".otf")) return "font/opentype";
  return "font/woff2";
}
function extractFontUrlsFromCSS(css) {
  const urls = [];
  const urlRegex = /url\(['"]?([^'")]+)['"]?\)/g;
  let match;
  while ((match = urlRegex.exec(css)) !== null) {
    const url = match[1];
    if (url && url.startsWith("/")) {
      urls.push(url);
    }
  }
  return urls;
}
function collectFontPreloadsFromCSS(css) {
  if (typeof document !== "undefined") return;
  const urls = extractFontUrlsFromCSS(css);
  for (const href of urls) {
    if (!ssrFontPreloadHrefs.has(href)) {
      ssrFontPreloadHrefs.add(href);
      ssrFontPreloads$1.push({ href, type: getFontMimeType(href) });
    }
  }
}
const injectedSelfHosted = /* @__PURE__ */ new Set();
function injectSelfHostedCSS(css) {
  if (injectedSelfHosted.has(css)) return;
  injectedSelfHosted.add(css);
  collectFontPreloadsFromCSS(css);
  if (typeof document === "undefined") {
    ssrFontStyles$1.push(css);
    return;
  }
  const style = document.createElement("style");
  style.textContent = css;
  style.setAttribute("data-vinext-font-selfhosted", "true");
  document.head.appendChild(style);
}
function createFontLoader(family) {
  return function fontLoader(options = {}) {
    const id = classCounter++;
    const className = `__font_${family.toLowerCase().replace(/\s+/g, "_")}_${id}`;
    const fallback = options.fallback ?? ["sans-serif"];
    const fontFamily = `'${escapeCSSString(family)}', ${fallback.map(sanitizeFallback).join(", ")}`;
    const defaultVarName = toVarName(family);
    const cssVarName = options.variable ? sanitizeCSSVarName(options.variable) ?? defaultVarName : defaultVarName;
    const variableClassName = `__variable_${family.toLowerCase().replace(/\s+/g, "_")}_${id}`;
    if (options._selfHostedCSS) {
      injectSelfHostedCSS(options._selfHostedCSS);
    } else {
      const url = buildGoogleFontsUrl(family, options);
      injectFontStylesheet(url);
      if (typeof document === "undefined") {
        if (!ssrFontUrls.includes(url)) {
          ssrFontUrls.push(url);
        }
      }
    }
    injectClassNameRule(className, fontFamily);
    injectVariableClassRule(variableClassName, cssVarName, fontFamily);
    return {
      className,
      style: { fontFamily },
      variable: variableClassName
    };
  };
}
const googleFonts = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === "__esModule") return true;
      if (prop === "default") return googleFonts;
      const family = prop.replace(/([a-z])([A-Z])/g, "$1 $2");
      return createFontLoader(family);
    }
  }
);
const ssrFontStyles = [];
const ssrFontPreloads = [];
function getSSRFontStyles() {
  return [...ssrFontStyles];
}
function getSSRFontPreloads() {
  return [...ssrFontPreloads];
}
class NextRequest extends Request {
  _nextUrl;
  _cookies;
  constructor(input, init) {
    if (input instanceof Request) {
      const req = input;
      super(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        // @ts-expect-error - duplex is not in RequestInit type but needed for streams
        duplex: req.body ? "half" : void 0,
        ...init
      });
    } else {
      super(input, init);
    }
    const url = typeof input === "string" ? new URL(input, "http://localhost") : input instanceof URL ? input : new URL(input.url, "http://localhost");
    this._nextUrl = new NextURL(url);
    this._cookies = new RequestCookies(this.headers);
  }
  get nextUrl() {
    return this._nextUrl;
  }
  get cookies() {
    return this._cookies;
  }
  /**
   * Client IP address. Prefers Cloudflare's trusted CF-Connecting-IP header
   * over the spoofable X-Forwarded-For. Returns undefined if unavailable.
   */
  get ip() {
    return this.headers.get("cf-connecting-ip") ?? this.headers.get("x-real-ip") ?? this.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? void 0;
  }
  /**
   * Geolocation data. Platform-dependent (e.g., Cloudflare, Vercel).
   * Returns undefined if not available.
   */
  get geo() {
    const country = this.headers.get("cf-ipcountry") ?? this.headers.get("x-vercel-ip-country") ?? void 0;
    if (!country) return void 0;
    return {
      country,
      city: this.headers.get("cf-ipcity") ?? this.headers.get("x-vercel-ip-city") ?? void 0,
      region: this.headers.get("cf-region") ?? this.headers.get("x-vercel-ip-country-region") ?? void 0,
      latitude: this.headers.get("cf-iplatitude") ?? this.headers.get("x-vercel-ip-latitude") ?? void 0,
      longitude: this.headers.get("cf-iplongitude") ?? this.headers.get("x-vercel-ip-longitude") ?? void 0
    };
  }
}
class NextResponse extends Response {
  _cookies;
  constructor(body, init) {
    super(body, init);
    this._cookies = new ResponseCookies(this.headers);
  }
  get cookies() {
    return this._cookies;
  }
  /**
   * Create a JSON response.
   */
  static json(body, init) {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return new NextResponse(JSON.stringify(body), {
      ...init,
      headers
    });
  }
  /**
   * Create a redirect response.
   */
  static redirect(url, init) {
    const status = typeof init === "number" ? init : init?.status ?? 307;
    const destination = typeof url === "string" ? url : url.toString();
    const headers = new Headers(typeof init === "object" ? init?.headers : void 0);
    headers.set("Location", destination);
    return new NextResponse(null, { status, headers });
  }
  /**
   * Create a rewrite response (middleware pattern).
   * Sets the x-middleware-rewrite header.
   */
  static rewrite(destination, init) {
    const url = typeof destination === "string" ? destination : destination.toString();
    const headers = new Headers(init?.headers);
    headers.set("x-middleware-rewrite", url);
    return new NextResponse(null, { ...init, headers });
  }
  /**
   * Continue to the next handler (middleware pattern).
   * Sets the x-middleware-next header.
   */
  static next(init) {
    const headers = new Headers(init?.headers);
    headers.set("x-middleware-next", "1");
    if (init?.request?.headers) {
      for (const [key, value] of init.request.headers.entries()) {
        headers.set(`x-middleware-request-${key}`, value);
      }
    }
    return new NextResponse(null, { ...init, headers });
  }
}
class NextURL {
  _url;
  constructor(input, base) {
    this._url = new URL(input.toString(), base);
  }
  get href() {
    return this._url.href;
  }
  get origin() {
    return this._url.origin;
  }
  get protocol() {
    return this._url.protocol;
  }
  get host() {
    return this._url.host;
  }
  get hostname() {
    return this._url.hostname;
  }
  get port() {
    return this._url.port;
  }
  get pathname() {
    return this._url.pathname;
  }
  get search() {
    return this._url.search;
  }
  get searchParams() {
    return this._url.searchParams;
  }
  get hash() {
    return this._url.hash;
  }
  set pathname(value) {
    this._url.pathname = value;
  }
  set search(value) {
    this._url.search = value;
  }
  set hash(value) {
    this._url.hash = value;
  }
  clone() {
    return new NextURL(this._url.href);
  }
  toString() {
    return this._url.toString();
  }
}
class RequestCookies {
  _headers;
  constructor(headers) {
    this._headers = headers;
  }
  _parse() {
    const map = /* @__PURE__ */ new Map();
    const cookie = this._headers.get("cookie") ?? "";
    for (const part of cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      map.set(name, value);
    }
    return map;
  }
  get(name) {
    const value = this._parse().get(name);
    return value !== void 0 ? { name, value } : void 0;
  }
  getAll() {
    return [...this._parse().entries()].map(([name, value]) => ({ name, value }));
  }
  has(name) {
    return this._parse().has(name);
  }
  [Symbol.iterator]() {
    const entries = this.getAll().map((c) => [c.name, c]);
    return entries[Symbol.iterator]();
  }
}
const VALID_COOKIE_NAME_RE = /^[\x21\x23-\x27\x2A\x2B\x2D\x2E\x30-\x39\x41-\x5A\x5E-\x7A\x7C\x7E]+$/;
function validateCookieName(name) {
  if (!name || !VALID_COOKIE_NAME_RE.test(name)) {
    throw new Error(`Invalid cookie name: ${JSON.stringify(name)}`);
  }
}
function validateCookieAttributeValue(value, attributeName) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127 || value[i] === ";") {
      throw new Error(`Invalid cookie ${attributeName} value: ${JSON.stringify(value)}`);
    }
  }
}
class ResponseCookies {
  _headers;
  constructor(headers) {
    this._headers = headers;
  }
  set(name, value, options) {
    validateCookieName(name);
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (options?.path) {
      validateCookieAttributeValue(options.path, "Path");
      parts.push(`Path=${options.path}`);
    }
    if (options?.domain) {
      validateCookieAttributeValue(options.domain, "Domain");
      parts.push(`Domain=${options.domain}`);
    }
    if (options?.maxAge !== void 0) parts.push(`Max-Age=${options.maxAge}`);
    if (options?.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
    if (options?.httpOnly) parts.push("HttpOnly");
    if (options?.secure) parts.push("Secure");
    if (options?.sameSite) parts.push(`SameSite=${options.sameSite}`);
    this._headers.append("Set-Cookie", parts.join("; "));
    return this;
  }
  get(name) {
    for (const header of this._headers.getSetCookie()) {
      const eq = header.indexOf("=");
      if (eq === -1) continue;
      const cookieName = header.slice(0, eq);
      if (cookieName === name) {
        const semi = header.indexOf(";", eq);
        const raw = header.slice(eq + 1, semi === -1 ? void 0 : semi);
        let value;
        try {
          value = decodeURIComponent(raw);
        } catch {
          value = raw;
        }
        return { name, value };
      }
    }
    return void 0;
  }
  getAll() {
    const entries = [];
    for (const header of this._headers.getSetCookie()) {
      const eq = header.indexOf("=");
      if (eq === -1) continue;
      const cookieName = header.slice(0, eq);
      const semi = header.indexOf(";", eq);
      const raw = header.slice(eq + 1, semi === -1 ? void 0 : semi);
      let value;
      try {
        value = decodeURIComponent(raw);
      } catch {
        value = raw;
      }
      entries.push({ name: cookieName, value });
    }
    return entries;
  }
  delete(name) {
    this.set(name, "", { maxAge: 0, path: "/" });
    return this;
  }
  [Symbol.iterator]() {
    const entries = [];
    for (const header of this._headers.getSetCookie()) {
      const eq = header.indexOf("=");
      if (eq === -1) continue;
      const cookieName = header.slice(0, eq);
      const semi = header.indexOf(";", eq);
      const raw = header.slice(eq + 1, semi === -1 ? void 0 : semi);
      let value;
      try {
        value = decodeURIComponent(raw);
      } catch {
        value = raw;
      }
      entries.push([cookieName, { name: cookieName, value }]);
    }
    return entries[Symbol.iterator]();
  }
}
function middleware(request) {
  const url = new URL(request.url);
  const response = NextResponse.next();
  response.headers.set("x-custom-middleware", "active");
  if (url.pathname === "/old-page") {
    return NextResponse.redirect(new URL("/about", request.url));
  }
  if (url.pathname === "/rewritten") {
    return NextResponse.rewrite(new URL("/ssr", request.url));
  }
  if (url.pathname === "/blocked") {
    return new Response("Access Denied", { status: 403 });
  }
  if (url.pathname === "/middleware-throw") {
    throw new Error("middleware crash");
  }
  return response;
}
const config = {
  matcher: ["/((?!api|_next|favicon\\.ico).*)"]
};
const isServer = typeof window === "undefined";
const MAX_PREFETCH_CACHE_SIZE = 50;
function toRscUrl(href) {
  const [beforeHash] = href.split("#");
  const qIdx = beforeHash.indexOf("?");
  const pathname = qIdx === -1 ? beforeHash : beforeHash.slice(0, qIdx);
  const query = qIdx === -1 ? "" : beforeHash.slice(qIdx);
  const normalizedPath = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return normalizedPath + ".rsc" + query;
}
function getPrefetchCache() {
  if (isServer) return /* @__PURE__ */ new Map();
  const win = window;
  if (!win.__VINEXT_RSC_PREFETCH_CACHE__) {
    win.__VINEXT_RSC_PREFETCH_CACHE__ = /* @__PURE__ */ new Map();
  }
  return win.__VINEXT_RSC_PREFETCH_CACHE__;
}
function getPrefetchedUrls() {
  if (isServer) return /* @__PURE__ */ new Set();
  const win = window;
  if (!win.__VINEXT_RSC_PREFETCHED_URLS__) {
    win.__VINEXT_RSC_PREFETCHED_URLS__ = /* @__PURE__ */ new Set();
  }
  return win.__VINEXT_RSC_PREFETCHED_URLS__;
}
function storePrefetchResponse(rscUrl, response) {
  const cache = getPrefetchCache();
  if (cache.size >= MAX_PREFETCH_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== void 0) cache.delete(oldest);
  }
  cache.set(rscUrl, { response, timestamp: Date.now() });
}
const _listeners = /* @__PURE__ */ new Set();
function notifyListeners() {
  for (const fn of _listeners) fn();
}
let _cachedSearch = !isServer ? window.location.search : "";
new URLSearchParams(_cachedSearch);
!isServer ? window.history.replaceState.bind(window.history) : null;
function restoreScrollPosition(state) {
  if (state && typeof state === "object" && "__vinext_scrollY" in state) {
    const { __vinext_scrollX: x, __vinext_scrollY: y } = state;
    Promise.resolve().then(() => {
      const pending = window.__VINEXT_RSC_PENDING__ ?? null;
      if (pending) {
        pending.then(() => {
          requestAnimationFrame(() => {
            window.scrollTo(x, y);
          });
        });
      } else {
        requestAnimationFrame(() => {
          window.scrollTo(x, y);
        });
      }
    });
  }
}
if (!isServer) {
  window.addEventListener("popstate", (event) => {
    notifyListeners();
    restoreScrollPosition(event.state);
  });
  const originalPushState = window.history.pushState.bind(window.history);
  const originalReplaceState = window.history.replaceState.bind(window.history);
  window.history.pushState = function patchedPushState(data, unused, url) {
    originalPushState(data, unused, url);
    notifyListeners();
  };
  window.history.replaceState = function patchedReplaceState(data, unused, url) {
    originalReplaceState(data, unused, url);
    notifyListeners();
  };
}
const LinkStatusContext = createContext({ pending: false });
function resolveHref(href) {
  if (typeof href === "string") return href;
  let url = href.pathname ?? "/";
  if (href.query) {
    const params = new URLSearchParams(href.query);
    url += `?${params.toString()}`;
  }
  return url;
}
function withBasePath(path) {
  {
    return path;
  }
}
function isHashOnlyChange(href) {
  if (href.startsWith("#")) return true;
  try {
    const current = new URL(window.location.href);
    const next = new URL(href, window.location.href);
    return current.pathname === next.pathname && current.search === next.search && next.hash !== "";
  } catch {
    return false;
  }
}
function resolveRelativeHref(href) {
  if (typeof window === "undefined") return href;
  if (href.startsWith("/") || href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//")) {
    return href;
  }
  try {
    const resolved = new URL(href, window.location.href);
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return href;
  }
}
function scrollToHash(hash) {
  if (!hash || hash === "#") {
    window.scrollTo(0, 0);
    return;
  }
  const id = hash.slice(1);
  const element = document.getElementById(id);
  if (element) {
    element.scrollIntoView({ behavior: "auto" });
  }
}
function prefetchUrl(href) {
  if (typeof window === "undefined") return;
  const fullHref = withBasePath(href);
  if (fullHref.startsWith("http://") || fullHref.startsWith("https://") || fullHref.startsWith("//")) return;
  const rscUrl = toRscUrl(fullHref);
  const prefetched = getPrefetchedUrls();
  if (prefetched.has(rscUrl)) return;
  prefetched.add(rscUrl);
  const schedule = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 100));
  schedule(() => {
    const win = window;
    if (typeof win.__VINEXT_RSC_NAVIGATE__ === "function") {
      fetch(rscUrl, {
        headers: { Accept: "text/x-component" },
        priority: "low",
        // @ts-expect-error — purpose is a valid fetch option in some browsers
        purpose: "prefetch"
      }).then((response) => {
        if (response.ok) {
          storePrefetchResponse(rscUrl, response);
        } else {
          prefetched.delete(rscUrl);
        }
      }).catch(() => {
        prefetched.delete(rscUrl);
      });
    } else if (win.__NEXT_DATA__?.__vinext?.pageModuleUrl) {
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = fullHref;
      link.as = "document";
      document.head.appendChild(link);
    }
  });
}
let sharedObserver = null;
const observerCallbacks = /* @__PURE__ */ new WeakMap();
function getSharedObserver() {
  if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") return null;
  if (sharedObserver) return sharedObserver;
  sharedObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const callback = observerCallbacks.get(entry.target);
          if (callback) {
            callback();
            sharedObserver?.unobserve(entry.target);
            observerCallbacks.delete(entry.target);
          }
        }
      }
    },
    {
      // Start prefetching when the link is within 250px of the viewport.
      // This gives the browser a head start before the user scrolls to it.
      rootMargin: "250px"
    }
  );
  return sharedObserver;
}
function getDefaultLocale() {
  if (typeof window !== "undefined") {
    return window.__VINEXT_DEFAULT_LOCALE__;
  }
  return globalThis.__VINEXT_DEFAULT_LOCALE__;
}
function applyLocaleToHref(href, locale) {
  if (locale === false) {
    return href;
  }
  if (locale === void 0) {
    return href;
  }
  const defaultLocale = getDefaultLocale();
  if (locale === defaultLocale) {
    return href;
  }
  if (href.startsWith(`/${locale}/`) || href === `/${locale}`) {
    return href;
  }
  return `/${locale}${href.startsWith("/") ? href : `/${href}`}`;
}
const Link = forwardRef(function Link2({ href, as, replace = false, prefetch: prefetchProp, scroll = true, children, onClick, onNavigate, ...rest }, forwardedRef) {
  const { locale, ...restWithoutLocale } = rest;
  const resolvedHref = as ?? resolveHref(href);
  const localizedHref = applyLocaleToHref(resolvedHref, locale);
  const fullHref = withBasePath(localizedHref);
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const internalRef = useRef(null);
  const shouldPrefetch = prefetchProp !== false;
  const setRefs = useCallback(
    (node) => {
      internalRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef]
  );
  useEffect(() => {
    if (!shouldPrefetch || typeof window === "undefined") return;
    const node = internalRef.current;
    if (!node) return;
    if (localizedHref.startsWith("http://") || localizedHref.startsWith("https://") || localizedHref.startsWith("//")) return;
    const observer = getSharedObserver();
    if (!observer) return;
    observerCallbacks.set(node, () => prefetchUrl(localizedHref));
    observer.observe(node);
    return () => {
      observer.unobserve(node);
      observerCallbacks.delete(node);
    };
  }, [shouldPrefetch, localizedHref]);
  const handleClick = async (e) => {
    if (onClick) onClick(e);
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    if (e.currentTarget.target && e.currentTarget.target !== "_self") {
      return;
    }
    if (resolvedHref.startsWith("http://") || resolvedHref.startsWith("https://") || resolvedHref.startsWith("//")) {
      return;
    }
    e.preventDefault();
    if (onNavigate) {
      try {
        const navUrl = new URL(resolvedHref, window.location.origin);
        let prevented = false;
        const navEvent = {
          url: navUrl,
          preventDefault() {
            prevented = true;
          },
          get defaultPrevented() {
            return prevented;
          }
        };
        onNavigate(navEvent);
        if (navEvent.defaultPrevented) {
          return;
        }
      } catch {
      }
    }
    if (!replace) {
      const state = window.history.state ?? {};
      window.history.replaceState(
        { ...state, __vinext_scrollX: window.scrollX, __vinext_scrollY: window.scrollY },
        ""
      );
    }
    const absoluteHref = resolveRelativeHref(resolvedHref);
    const absoluteFullHref = withBasePath(absoluteHref);
    if (typeof window !== "undefined" && isHashOnlyChange(absoluteFullHref)) {
      const hash2 = absoluteFullHref.includes("#") ? absoluteFullHref.slice(absoluteFullHref.indexOf("#")) : "";
      if (replace) {
        window.history.replaceState(null, "", absoluteFullHref);
      } else {
        window.history.pushState(null, "", absoluteFullHref);
      }
      if (scroll) {
        scrollToHash(hash2);
      }
      return;
    }
    const hashIdx = absoluteFullHref.indexOf("#");
    const hash = hashIdx !== -1 ? absoluteFullHref.slice(hashIdx) : "";
    const win = window;
    if (typeof win.__VINEXT_RSC_NAVIGATE__ === "function") {
      if (replace) {
        window.history.replaceState(null, "", absoluteFullHref);
      } else {
        window.history.pushState(null, "", absoluteFullHref);
      }
      setPending(true);
      try {
        await win.__VINEXT_RSC_NAVIGATE__(absoluteFullHref);
      } finally {
        if (mountedRef.current) setPending(false);
      }
    } else {
      try {
        const routerModule = await Promise.resolve().then(() => router);
        const Router2 = routerModule.default;
        if (replace) {
          await Router2.replace(absoluteHref, void 0, { scroll });
        } else {
          await Router2.push(absoluteHref, void 0, { scroll });
        }
      } catch {
        if (replace) {
          window.history.replaceState({}, "", absoluteFullHref);
        } else {
          window.history.pushState({}, "", absoluteFullHref);
        }
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
    }
    if (scroll) {
      if (hash) {
        scrollToHash(hash);
      } else {
        window.scrollTo(0, 0);
      }
    }
  };
  const { passHref: _p, ...anchorProps } = restWithoutLocale;
  const linkStatusValue = React.useMemo(() => ({ pending }), [pending]);
  return /* @__PURE__ */ jsxDEV(LinkStatusContext.Provider, { value: linkStatusValue, children: /* @__PURE__ */ jsxDEV("a", { ref: setRefs, href: fullHref, onClick: handleClick, ...anchorProps, children }, void 0, false, {
    fileName: "/home/runner/work/vinext/vinext/packages/vinext/src/shims/link.tsx",
    lineNumber: 465,
    columnNumber: 7
  }, this) }, void 0, false, {
    fileName: "/home/runner/work/vinext/vinext/packages/vinext/src/shims/link.tsx",
    lineNumber: 464,
    columnNumber: 5
  }, this);
});
function Home() {
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV(Head$1, { children: /* @__PURE__ */ jsxDEV("title", { children: "Hello vinext" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/index.tsx",
      lineNumber: 8,
      columnNumber: 9
    }, this) }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/index.tsx",
      lineNumber: 7,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("h1", { children: "Hello, vinext!" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/index.tsx",
      lineNumber: 10,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { children: "This is a Pages Router app running on Vite." }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/index.tsx",
      lineNumber: 11,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(Link, { href: "/about", children: "Go to About" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/index.tsx",
      lineNumber: 12,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/index.tsx",
    lineNumber: 6,
    columnNumber: 5
  }, this);
}
const page_0 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: Home
}, Symbol.toStringTag, { value: "Module" }));
function Custom404() {
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { "data-testid": "error-title", children: "404 - Page Not Found" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/404.tsx",
      lineNumber: 4,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { "data-testid": "error-message", children: "Sorry, the page you are looking for does not exist." }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/404.tsx",
      lineNumber: 5,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/404.tsx",
    lineNumber: 3,
    columnNumber: 5
  }, this);
}
const page_1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: Custom404
}, Symbol.toStringTag, { value: "Module" }));
function About() {
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV(Head$1, { children: /* @__PURE__ */ jsxDEV("title", { children: "About - vinext" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/about.tsx",
      lineNumber: 8,
      columnNumber: 9
    }, this) }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/about.tsx",
      lineNumber: 7,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("h1", { children: "About" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/about.tsx",
      lineNumber: 10,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { children: "This is the about page." }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/about.tsx",
      lineNumber: 11,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(Link, { href: "/", children: "Back to Home" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/about.tsx",
      lineNumber: 12,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/about.tsx",
    lineNumber: 6,
    columnNumber: 5
  }, this);
}
const page_2 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: About
}, Symbol.toStringTag, { value: "Module" }));
function HeavyComponent$1({ label }) {
  return /* @__PURE__ */ jsxDEV("div", { className: "heavy-component", children: [
    /* @__PURE__ */ jsxDEV("h2", { children: "Heavy Component" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/components/heavy.tsx",
      lineNumber: 6,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { children: label ?? "I was dynamically imported!" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/components/heavy.tsx",
      lineNumber: 7,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/components/heavy.tsx",
    lineNumber: 5,
    columnNumber: 5
  }, this);
}
const heavy = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: HeavyComponent$1
}, Symbol.toStringTag, { value: "Module" }));
function AliasTestPage() {
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { children: "Pages Alias Test" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/alias-test.tsx",
      lineNumber: 6,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { children: "This page imports a component via tsconfig path alias @/" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/alias-test.tsx",
      lineNumber: 7,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(HeavyComponent$1, { label: "Loaded via alias" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/alias-test.tsx",
      lineNumber: 8,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/alias-test.tsx",
    lineNumber: 5,
    columnNumber: 5
  }, this);
}
const page_3 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: AliasTestPage
}, Symbol.toStringTag, { value: "Module" }));
function BeforePopStateTest() {
  const router2 = useRouter();
  const [blocking, setBlocking] = useState(false);
  const [popAttempts, setPopAttempts] = useState(0);
  useEffect(() => {
    if (blocking) {
      router2.beforePopState(() => {
        window.__popBlocked = (window.__popBlocked || 0) + 1;
        setPopAttempts((prev) => prev + 1);
        return false;
      });
    } else {
      router2.beforePopState(() => true);
    }
  }, [blocking, router2]);
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { children: "Before Pop State Test" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/before-pop-state-test.tsx",
      lineNumber: 31,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(Link, { href: "/about", "data-testid": "link-about", children: "Go to About" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/before-pop-state-test.tsx",
      lineNumber: 32,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(
      "button",
      {
        "data-testid": "toggle-blocking",
        onClick: () => setBlocking(!blocking),
        children: blocking ? "Blocking: ON" : "Blocking: OFF"
      },
      void 0,
      false,
      {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/before-pop-state-test.tsx",
        lineNumber: 35,
        columnNumber: 7
      },
      this
    ),
    /* @__PURE__ */ jsxDEV(
      "button",
      {
        "data-testid": "enable-blocking",
        onClick: () => setBlocking(true),
        children: "Enable Blocking"
      },
      void 0,
      false,
      {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/before-pop-state-test.tsx",
        lineNumber: 41,
        columnNumber: 7
      },
      this
    ),
    /* @__PURE__ */ jsxDEV("div", { "data-testid": "pop-attempts", children: popAttempts }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/before-pop-state-test.tsx",
      lineNumber: 47,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("div", { "data-testid": "current-path", children: router2.asPath }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/before-pop-state-test.tsx",
      lineNumber: 48,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/before-pop-state-test.tsx",
    lineNumber: 30,
    columnNumber: 5
  }, this);
}
const page_4 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: BeforePopStateTest
}, Symbol.toStringTag, { value: "Module" }));
let runtimeConfig = {
  serverRuntimeConfig: {},
  publicRuntimeConfig: {}
};
function getConfig() {
  return runtimeConfig;
}
function ConfigTestPage() {
  const { publicRuntimeConfig } = getConfig();
  const appName = publicRuntimeConfig?.appName ?? "default-app";
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { children: "Config Test" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/config-test.tsx",
      lineNumber: 8,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { id: "app-name", children: [
      "App: ",
      appName
    ] }, void 0, true, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/config-test.tsx",
      lineNumber: 9,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/config-test.tsx",
    lineNumber: 7,
    columnNumber: 5
  }, this);
}
const page_5 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: ConfigTestPage
}, Symbol.toStringTag, { value: "Module" }));
function CounterPage() {
  const [count, setCount] = useState(0);
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV(Head$1, { children: /* @__PURE__ */ jsxDEV("title", { children: "Counter - vinext" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/counter.tsx",
      lineNumber: 10,
      columnNumber: 9
    }, this) }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/counter.tsx",
      lineNumber: 9,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("h1", { children: "Counter Page" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/counter.tsx",
      lineNumber: 12,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { "data-testid": "count", children: [
      "Count: ",
      count
    ] }, void 0, true, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/counter.tsx",
      lineNumber: 13,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("button", { "data-testid": "increment", onClick: () => setCount((c) => c + 1), children: "Increment" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/counter.tsx",
      lineNumber: 14,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("button", { "data-testid": "decrement", onClick: () => setCount((c) => c - 1), children: "Decrement" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/counter.tsx",
      lineNumber: 17,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(Link, { href: "/", children: "Back to Home" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/counter.tsx",
      lineNumber: 20,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/counter.tsx",
    lineNumber: 8,
    columnNumber: 5
  }, this);
}
const page_6 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: CounterPage
}, Symbol.toStringTag, { value: "Module" }));
const HeavyComponent = dynamic(() => Promise.resolve().then(() => heavy), {
  loading: () => /* @__PURE__ */ jsxDEV("p", { children: "Loading heavy component..." }, void 0, false, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/dynamic-page.tsx",
    lineNumber: 5,
    columnNumber: 18
  }, void 0)
});
function DynamicPage() {
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { children: "Dynamic Import Page" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/dynamic-page.tsx",
      lineNumber: 11,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(HeavyComponent, { label: "Loaded dynamically" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/dynamic-page.tsx",
      lineNumber: 12,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/dynamic-page.tsx",
    lineNumber: 10,
    columnNumber: 5
  }, this);
}
const page_7 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: DynamicPage
}, Symbol.toStringTag, { value: "Module" }));
const ClientOnly = dynamic(
  () => import("./assets/client-only-component-GBpKjLOL.js"),
  {
    ssr: false,
    loading: () => /* @__PURE__ */ jsxDEV("p", { "data-testid": "loading", children: "Loading client component..." }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/dynamic-ssr-false.tsx",
      lineNumber: 7,
      columnNumber: 20
    }, void 0)
  }
);
const ClientOnlyNoLoading = dynamic(
  () => import("./assets/client-only-component-GBpKjLOL.js"),
  { ssr: false }
);
function DynamicSsrFalsePage() {
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { children: "Dynamic SSR False Test" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/dynamic-ssr-false.tsx",
      lineNumber: 19,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("div", { "data-testid": "with-loading", children: /* @__PURE__ */ jsxDEV(ClientOnly, {}, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/dynamic-ssr-false.tsx",
      lineNumber: 21,
      columnNumber: 9
    }, this) }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/dynamic-ssr-false.tsx",
      lineNumber: 20,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("div", { "data-testid": "without-loading", children: /* @__PURE__ */ jsxDEV(ClientOnlyNoLoading, {}, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/dynamic-ssr-false.tsx",
      lineNumber: 24,
      columnNumber: 9
    }, this) }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/dynamic-ssr-false.tsx",
      lineNumber: 23,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/dynamic-ssr-false.tsx",
    lineNumber: 18,
    columnNumber: 5
  }, this);
}
const page_8 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: DynamicSsrFalsePage
}, Symbol.toStringTag, { value: "Module" }));
function ISRPage({ timestamp, message }) {
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { children: "ISR Page" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/isr-test.tsx",
      lineNumber: 9,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { "data-testid": "message", children: message }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/isr-test.tsx",
      lineNumber: 10,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { "data-testid": "timestamp", children: timestamp }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/isr-test.tsx",
      lineNumber: 11,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/isr-test.tsx",
    lineNumber: 8,
    columnNumber: 5
  }, this);
}
async function getStaticProps$4() {
  return {
    props: {
      timestamp: Date.now(),
      message: "Hello from ISR"
    },
    revalidate: 1
    // Revalidate every 1 second
  };
}
const page_9 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: ISRPage,
  getStaticProps: getStaticProps$4
}, Symbol.toStringTag, { value: "Module" }));
function LinkTestPage() {
  const router2 = useRouter();
  const [preventedNav, setPreventedNav] = useState(false);
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { children: "Link Advanced Props Test" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/link-test.tsx",
      lineNumber: 11,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("div", { style: { height: "200vh", background: "linear-gradient(white, #eee)" }, children: /* @__PURE__ */ jsxDEV("p", { children: "Tall content area" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/link-test.tsx",
      lineNumber: 15,
      columnNumber: 9
    }, this) }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/link-test.tsx",
      lineNumber: 14,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("div", { "data-testid": "links", style: { marginTop: 20 }, children: [
      /* @__PURE__ */ jsxDEV(Link, { href: "/about", scroll: false, "data-testid": "link-no-scroll", children: "No Scroll Link" }, void 0, false, {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/link-test.tsx",
        lineNumber: 20,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV(Link, { href: "/about", replace: true, "data-testid": "link-replace", children: "Replace Link" }, void 0, false, {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/link-test.tsx",
        lineNumber: 25,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV(Link, { href: "/blog/[slug]", as: "/blog/test-post", "data-testid": "link-as", children: "As Prop Link" }, void 0, false, {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/link-test.tsx",
        lineNumber: 30,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV(
        Link,
        {
          href: "/about",
          "data-testid": "link-prevent",
          onClick: (e) => {
            e.preventDefault();
            setPreventedNav(true);
          },
          children: "Prevented Link"
        },
        void 0,
        false,
        {
          fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/link-test.tsx",
          lineNumber: 35,
          columnNumber: 9
        },
        this
      ),
      /* @__PURE__ */ jsxDEV(Link, { href: "/about", target: "_blank", "data-testid": "link-blank", children: "Blank Target Link" }, void 0, false, {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/link-test.tsx",
        lineNumber: 47,
        columnNumber: 9
      }, this)
    ] }, void 0, true, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/link-test.tsx",
      lineNumber: 18,
      columnNumber: 7
    }, this),
    preventedNav && /* @__PURE__ */ jsxDEV("div", { "data-testid": "prevented-message", children: "Navigation was prevented" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/link-test.tsx",
      lineNumber: 53,
      columnNumber: 9
    }, this),
    /* @__PURE__ */ jsxDEV("div", { "data-testid": "current-path", children: router2.asPath }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/link-test.tsx",
      lineNumber: 56,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/link-test.tsx",
    lineNumber: 10,
    columnNumber: 5
  }, this);
}
const page_10 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: LinkTestPage
}, Symbol.toStringTag, { value: "Module" }));
function NavTestPage() {
  const router2 = useRouter();
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { children: "Navigation Test" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/nav-test.tsx",
      lineNumber: 8,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { "data-testid": "pathname", children: [
      "Current: ",
      router2.pathname
    ] }, void 0, true, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/nav-test.tsx",
      lineNumber: 9,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(
      "button",
      {
        "data-testid": "push-about",
        onClick: () => router2.push("/about"),
        children: "Push to About"
      },
      void 0,
      false,
      {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/nav-test.tsx",
        lineNumber: 10,
        columnNumber: 7
      },
      this
    ),
    /* @__PURE__ */ jsxDEV(
      "button",
      {
        "data-testid": "replace-ssr",
        onClick: () => router2.replace("/ssr"),
        children: "Replace to SSR"
      },
      void 0,
      false,
      {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/nav-test.tsx",
        lineNumber: 16,
        columnNumber: 7
      },
      this
    ),
    /* @__PURE__ */ jsxDEV(
      "button",
      {
        "data-testid": "push-counter",
        onClick: () => router2.push("/counter"),
        children: "Push to Counter"
      },
      void 0,
      false,
      {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/nav-test.tsx",
        lineNumber: 22,
        columnNumber: 7
      },
      this
    ),
    /* @__PURE__ */ jsxDEV(Link, { href: "/", "data-testid": "link-home", children: "Link to Home" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/nav-test.tsx",
      lineNumber: 28,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(Link, { href: "/about", "data-testid": "link-about", children: "Link to About" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/nav-test.tsx",
      lineNumber: 29,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(Link, { href: "/ssr", "data-testid": "link-ssr", children: "Link to SSR" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/nav-test.tsx",
      lineNumber: 30,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/nav-test.tsx",
    lineNumber: 7,
    columnNumber: 5
  }, this);
}
const page_11 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: NavTestPage
}, Symbol.toStringTag, { value: "Module" }));
function MissingPost() {
  return /* @__PURE__ */ jsxDEV("div", { children: "This should never render" }, void 0, false, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/posts/missing.tsx",
    lineNumber: 5,
    columnNumber: 10
  }, this);
}
async function getServerSideProps$4() {
  return {
    notFound: true
  };
}
const page_12 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: MissingPost,
  getServerSideProps: getServerSideProps$4
}, Symbol.toStringTag, { value: "Module" }));
function RedirectXss() {
  return /* @__PURE__ */ jsxDEV("div", { children: "Should not render" }, void 0, false, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/redirect-xss.tsx",
    lineNumber: 4,
    columnNumber: 10
  }, this);
}
function getStaticProps$3() {
  return {
    redirect: {
      destination: 'foo" /><script>alert(1)<\/script><meta x="'
    }
  };
}
const page_13 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: RedirectXss,
  getStaticProps: getStaticProps$3
}, Symbol.toStringTag, { value: "Module" }));
const STORAGE_KEY = "router-events-log";
function getStoredEvents() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function storeEvent(event) {
  const events = getStoredEvents();
  events.push(event);
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(events));
}
function RouterEventsTest() {
  const router2 = useRouter();
  const [events, setEvents] = useState([]);
  useEffect(() => {
    setEvents(getStoredEvents());
  }, []);
  useEffect(() => {
    const onStart = (url) => {
      storeEvent(`start:${url}`);
      setEvents(getStoredEvents());
    };
    const onComplete = (url) => {
      storeEvent(`complete:${url}`);
      setEvents(getStoredEvents());
    };
    const onError = (err, url) => {
      storeEvent(`error:${url}:${err.message}`);
      setEvents(getStoredEvents());
    };
    router2.events.on("routeChangeStart", onStart);
    router2.events.on("routeChangeComplete", onComplete);
    router2.events.on("routeChangeError", onError);
    return () => {
      router2.events.off("routeChangeStart", onStart);
      router2.events.off("routeChangeComplete", onComplete);
      router2.events.off("routeChangeError", onError);
    };
  }, [router2]);
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { children: "Router Events Test" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/router-events-test.tsx",
      lineNumber: 58,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(Link, { href: "/about", children: /* @__PURE__ */ jsxDEV("span", { "data-testid": "link-about", children: "Go to About" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/router-events-test.tsx",
      lineNumber: 60,
      columnNumber: 9
    }, this) }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/router-events-test.tsx",
      lineNumber: 59,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(
      "button",
      {
        "data-testid": "push-about",
        onClick: () => router2.push("/about"),
        children: "Push About"
      },
      void 0,
      false,
      {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/router-events-test.tsx",
        lineNumber: 62,
        columnNumber: 7
      },
      this
    ),
    /* @__PURE__ */ jsxDEV(
      "button",
      {
        "data-testid": "push-ssr",
        onClick: () => router2.push("/ssr"),
        children: "Push SSR"
      },
      void 0,
      false,
      {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/router-events-test.tsx",
        lineNumber: 68,
        columnNumber: 7
      },
      this
    ),
    /* @__PURE__ */ jsxDEV(
      "button",
      {
        "data-testid": "clear-events",
        onClick: () => {
          sessionStorage.removeItem(STORAGE_KEY);
          setEvents([]);
        },
        children: "Clear Events"
      },
      void 0,
      false,
      {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/router-events-test.tsx",
        lineNumber: 74,
        columnNumber: 7
      },
      this
    ),
    /* @__PURE__ */ jsxDEV("div", { "data-testid": "event-log", children: events.join("|") }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/router-events-test.tsx",
      lineNumber: 83,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("div", { "data-testid": "event-count", children: events.length }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/router-events-test.tsx",
      lineNumber: 84,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/router-events-test.tsx",
    lineNumber: 57,
    columnNumber: 5
  }, this);
}
const page_14 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: RouterEventsTest
}, Symbol.toStringTag, { value: "Module" }));
const loadedScripts = /* @__PURE__ */ new Set();
function Script(props) {
  const {
    src,
    id,
    strategy = "afterInteractive",
    onLoad,
    onReady,
    onError,
    children,
    dangerouslySetInnerHTML,
    ...rest
  } = props;
  const hasMounted = useRef(false);
  if (typeof window === "undefined") {
    if (strategy === "beforeInteractive") {
      const scriptProps = { ...rest };
      if (src) scriptProps.src = src;
      if (id) scriptProps.id = id;
      if (dangerouslySetInnerHTML) {
        scriptProps.dangerouslySetInnerHTML = dangerouslySetInnerHTML;
      }
      return React.createElement("script", scriptProps, children);
    }
    return null;
  }
  const key = id ?? src ?? "";
  useEffect(() => {
    if (hasMounted.current) return;
    hasMounted.current = true;
    if (key && loadedScripts.has(key)) {
      onReady?.();
      return;
    }
    const load = () => {
      if (key && loadedScripts.has(key)) {
        onReady?.();
        return;
      }
      const el = document.createElement("script");
      if (src) el.src = src;
      if (id) el.id = id;
      for (const [attr, value] of Object.entries(rest)) {
        if (attr === "className") {
          el.setAttribute("class", String(value));
        } else if (typeof value === "string") {
          el.setAttribute(attr, value);
        } else if (typeof value === "boolean" && value) {
          el.setAttribute(attr, "");
        }
      }
      if (strategy === "worker") {
        el.setAttribute("type", "text/partytown");
      }
      if (dangerouslySetInnerHTML?.__html) {
        el.innerHTML = dangerouslySetInnerHTML.__html;
      } else if (children && typeof children === "string") {
        el.textContent = children;
      }
      el.addEventListener("load", (e) => {
        if (key) loadedScripts.add(key);
        onLoad?.(e);
        onReady?.();
      });
      if (onError) {
        el.addEventListener("error", onError);
      }
      document.body.appendChild(el);
    };
    if (strategy === "lazyOnload") {
      if (document.readyState === "complete") {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(load);
        } else {
          setTimeout(load, 1);
        }
      } else {
        window.addEventListener("load", () => {
          if (typeof requestIdleCallback === "function") {
            requestIdleCallback(load);
          } else {
            setTimeout(load, 1);
          }
        });
      }
    } else {
      load();
    }
  }, [src, id, strategy, onLoad, onReady, onError, children, dangerouslySetInnerHTML, key, rest]);
  return null;
}
function ScriptTestPage() {
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { children: "Script Test" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/script-test.tsx",
      lineNumber: 6,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(
      Script,
      {
        id: "test-analytics",
        strategy: "beforeInteractive",
        src: "https://example.com/analytics.js"
      },
      void 0,
      false,
      {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/script-test.tsx",
        lineNumber: 7,
        columnNumber: 7
      },
      this
    ),
    /* @__PURE__ */ jsxDEV("p", { children: "Page with scripts" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/script-test.tsx",
      lineNumber: 12,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/script-test.tsx",
    lineNumber: 5,
    columnNumber: 5
  }, this);
}
const page_15 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: ScriptTestPage
}, Symbol.toStringTag, { value: "Module" }));
let gsspCallCount = 0;
async function getServerSideProps$3(ctx) {
  gsspCallCount++;
  const serverQuery = {};
  for (const [k, v] of Object.entries(ctx.query)) {
    serverQuery[k] = Array.isArray(v) ? v[0] : v ?? "";
  }
  return {
    props: {
      gsspCallId: gsspCallCount,
      serverQuery
    }
  };
}
function ShallowTestPage({ gsspCallId, serverQuery }) {
  const router2 = useRouter();
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { children: "Shallow Routing Test" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/shallow-test.tsx",
      lineNumber: 31,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { "data-testid": "gssp-call-id", children: [
      "gssp:",
      gsspCallId
    ] }, void 0, true, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/shallow-test.tsx",
      lineNumber: 32,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { "data-testid": "router-query", children: JSON.stringify(router2.query) }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/shallow-test.tsx",
      lineNumber: 33,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { "data-testid": "server-query", children: JSON.stringify(serverQuery) }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/shallow-test.tsx",
      lineNumber: 34,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { "data-testid": "router-pathname", children: router2.pathname }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/shallow-test.tsx",
      lineNumber: 35,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { "data-testid": "router-asPath", children: router2.asPath }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/shallow-test.tsx",
      lineNumber: 36,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(
      "button",
      {
        "data-testid": "shallow-push",
        onClick: () => router2.push("/shallow-test?tab=settings", void 0, { shallow: true }),
        children: "Shallow Push"
      },
      void 0,
      false,
      {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/shallow-test.tsx",
        lineNumber: 37,
        columnNumber: 7
      },
      this
    ),
    /* @__PURE__ */ jsxDEV(
      "button",
      {
        "data-testid": "deep-push",
        onClick: () => router2.push("/shallow-test?tab=profile"),
        children: "Deep Push"
      },
      void 0,
      false,
      {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/shallow-test.tsx",
        lineNumber: 43,
        columnNumber: 7
      },
      this
    ),
    /* @__PURE__ */ jsxDEV(
      "button",
      {
        "data-testid": "shallow-replace",
        onClick: () => router2.replace("/shallow-test?view=grid", void 0, { shallow: true }),
        children: "Shallow Replace"
      },
      void 0,
      false,
      {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/shallow-test.tsx",
        lineNumber: 49,
        columnNumber: 7
      },
      this
    )
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/shallow-test.tsx",
    lineNumber: 30,
    columnNumber: 5
  }, this);
}
const page_16 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: ShallowTestPage,
  getServerSideProps: getServerSideProps$3
}, Symbol.toStringTag, { value: "Module" }));
function SSRPage({ timestamp, message }) {
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { children: "Server-Side Rendered" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/ssr.tsx",
      lineNumber: 9,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { "data-testid": "message", children: message }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/ssr.tsx",
      lineNumber: 10,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { "data-testid": "timestamp", children: [
      "Rendered at: ",
      timestamp
    ] }, void 0, true, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/ssr.tsx",
      lineNumber: 11,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/ssr.tsx",
    lineNumber: 8,
    columnNumber: 5
  }, this);
}
async function getServerSideProps$2() {
  return {
    props: {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      message: "Hello from getServerSideProps"
    }
  };
}
const page_17 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: SSRPage,
  getServerSideProps: getServerSideProps$2
}, Symbol.toStringTag, { value: "Module" }));
const LazyGreeting = lazy(
  () => new Promise((resolve) => {
    resolve({
      default: () => /* @__PURE__ */ jsxDEV("div", { "data-testid": "lazy-greeting", children: "Hello from lazy component" }, void 0, false, {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/suspense-test.tsx",
        lineNumber: 12,
        columnNumber: 11
      }, void 0)
    });
  })
);
function SuspenseTestPage() {
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { children: "Suspense Test" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/suspense-test.tsx",
      lineNumber: 21,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(Suspense, { fallback: /* @__PURE__ */ jsxDEV("div", { "data-testid": "loading", children: "Loading..." }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/suspense-test.tsx",
      lineNumber: 22,
      columnNumber: 27
    }, this), children: /* @__PURE__ */ jsxDEV(LazyGreeting, {}, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/suspense-test.tsx",
      lineNumber: 23,
      columnNumber: 9
    }, this) }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/suspense-test.tsx",
      lineNumber: 22,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/suspense-test.tsx",
    lineNumber: 20,
    columnNumber: 5
  }, this);
}
const page_18 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: SuspenseTestPage
}, Symbol.toStringTag, { value: "Module" }));
function Article({ id, title }) {
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { children: title }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/articles/[id].tsx",
      lineNumber: 11,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { children: [
      "Article ID: ",
      id
    ] }, void 0, true, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/articles/[id].tsx",
      lineNumber: 12,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/articles/[id].tsx",
    lineNumber: 10,
    columnNumber: 5
  }, this);
}
async function getStaticPaths$2() {
  return {
    paths: [
      { params: { id: "1" } },
      { params: { id: "2" } }
    ],
    fallback: "blocking"
  };
}
async function getStaticProps$2({ params }) {
  const titles = {
    "1": "First Article",
    "2": "Second Article"
  };
  return {
    props: {
      id: params.id,
      title: titles[params.id] ?? `Article ${params.id}`
    }
  };
}
const page_19 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: Article,
  getStaticPaths: getStaticPaths$2,
  getStaticProps: getStaticProps$2
}, Symbol.toStringTag, { value: "Module" }));
function BlogPost({ slug, title }) {
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { children: title }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/blog/[slug].tsx",
      lineNumber: 11,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { children: [
      "Blog post slug: ",
      slug
    ] }, void 0, true, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/blog/[slug].tsx",
      lineNumber: 12,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/blog/[slug].tsx",
    lineNumber: 10,
    columnNumber: 5
  }, this);
}
async function getStaticPaths$1() {
  return {
    paths: [
      { params: { slug: "hello-world" } },
      { params: { slug: "getting-started" } }
    ],
    fallback: false
  };
}
async function getStaticProps$1({ params }) {
  const titles = {
    "hello-world": "Hello World",
    "getting-started": "Getting Started with Nextcompat"
  };
  return {
    props: {
      slug: params.slug,
      title: titles[params.slug] ?? "Unknown Post"
    }
  };
}
const page_20 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: BlogPost,
  getStaticPaths: getStaticPaths$1,
  getStaticProps: getStaticProps$1
}, Symbol.toStringTag, { value: "Module" }));
function Post({ id }) {
  const router2 = useRouter();
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { "data-testid": "post-title", children: [
      "Post: ",
      id
    ] }, void 0, true, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/posts/[id].tsx",
      lineNumber: 12,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { "data-testid": "pathname", children: [
      "Pathname: ",
      router2.pathname
    ] }, void 0, true, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/posts/[id].tsx",
      lineNumber: 13,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { "data-testid": "query", children: [
      "Query ID: ",
      router2.query.id
    ] }, void 0, true, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/posts/[id].tsx",
      lineNumber: 14,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/posts/[id].tsx",
    lineNumber: 11,
    columnNumber: 5
  }, this);
}
async function getServerSideProps$1({ params }) {
  return {
    props: {
      id: params.id
    }
  };
}
const page_21 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: Post,
  getServerSideProps: getServerSideProps$1
}, Symbol.toStringTag, { value: "Module" }));
function Product({ pid, name }) {
  const router2 = useRouter();
  if (router2.isFallback) {
    return /* @__PURE__ */ jsxDEV("div", { children: "Loading product..." }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/products/[pid].tsx",
      lineNumber: 15,
      columnNumber: 12
    }, this);
  }
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { children: [
      "Product: ",
      name
    ] }, void 0, true, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/products/[pid].tsx",
      lineNumber: 20,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { children: [
      "Product ID: ",
      pid
    ] }, void 0, true, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/products/[pid].tsx",
      lineNumber: 21,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { "data-testid": "is-fallback", children: [
      "isFallback: ",
      String(router2.isFallback)
    ] }, void 0, true, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/products/[pid].tsx",
      lineNumber: 22,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/products/[pid].tsx",
    lineNumber: 19,
    columnNumber: 5
  }, this);
}
async function getStaticPaths() {
  return {
    paths: [
      { params: { pid: "widget" } },
      { params: { pid: "gadget" } }
    ],
    fallback: true
  };
}
async function getStaticProps({ params }) {
  const products = {
    widget: "Super Widget",
    gadget: "Mega Gadget"
  };
  return {
    props: {
      pid: params.pid,
      name: products[params.pid] ?? `Product ${params.pid}`
    }
  };
}
const page_22 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: Product,
  getStaticPaths,
  getStaticProps
}, Symbol.toStringTag, { value: "Module" }));
function DocsPage({ slug }) {
  return /* @__PURE__ */ jsxDEV("div", { children: [
    /* @__PURE__ */ jsxDEV("h1", { "data-testid": "docs-title", children: "Docs" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/docs/[...slug].tsx",
      lineNumber: 4,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("p", { "data-testid": "docs-slug", children: [
      "Path: ",
      slug.join("/")
    ] }, void 0, true, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/docs/[...slug].tsx",
      lineNumber: 5,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/docs/[...slug].tsx",
    lineNumber: 3,
    columnNumber: 5
  }, this);
}
async function getServerSideProps({
  params
}) {
  return {
    props: {
      slug: params.slug
    }
  };
}
const page_23 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: DocsPage,
  getServerSideProps
}, Symbol.toStringTag, { value: "Module" }));
function handler$3(_req, res) {
  const body = Buffer.from([255, 254, 253, 0, 97, 98, 99]);
  res.setHeader("Content-Type", "application/octet-stream");
  res.status(200).end(body);
}
const api_0 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: handler$3
}, Symbol.toStringTag, { value: "Module" }));
function handler$2(req, res) {
  res.status(200).json({ message: "Hello from API!" });
}
const api_1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: handler$2
}, Symbol.toStringTag, { value: "Module" }));
function handler$1(_req, res) {
  res.status(200).json({ ok: true, message: "middleware-test works" });
}
const api_2 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: handler$1
}, Symbol.toStringTag, { value: "Module" }));
function handler(req, res) {
  const { id } = req.query;
  res.status(200).json({ user: { id, name: `User ${id}` } });
}
const api_3 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: handler
}, Symbol.toStringTag, { value: "Module" }));
function MyApp({ Component, pageProps }) {
  return /* @__PURE__ */ jsxDEV("div", { id: "app-wrapper", "data-testid": "app-wrapper", children: [
    /* @__PURE__ */ jsxDEV("nav", { "data-testid": "global-nav", children: /* @__PURE__ */ jsxDEV("span", { children: "My App" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/_app.tsx",
      lineNumber: 7,
      columnNumber: 9
    }, this) }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/_app.tsx",
      lineNumber: 6,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(Component, { ...pageProps }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/_app.tsx",
      lineNumber: 9,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/_app.tsx",
    lineNumber: 5,
    columnNumber: 5
  }, this);
}
function Html({
  children,
  lang,
  ...props
}) {
  return /* @__PURE__ */ jsxDEV("html", { lang, ...props, children }, void 0, false, {
    fileName: "/home/runner/work/vinext/vinext/packages/vinext/src/shims/document.tsx",
    lineNumber: 16,
    columnNumber: 5
  }, this);
}
function Head({ children }) {
  return /* @__PURE__ */ jsxDEV("head", { children: [
    /* @__PURE__ */ jsxDEV("meta", { charSet: "utf-8" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/packages/vinext/src/shims/document.tsx",
      lineNumber: 29,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/packages/vinext/src/shims/document.tsx",
      lineNumber: 30,
      columnNumber: 7
    }, this),
    children
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/packages/vinext/src/shims/document.tsx",
    lineNumber: 28,
    columnNumber: 5
  }, this);
}
function Main() {
  return /* @__PURE__ */ jsxDEV("div", { id: "__next", dangerouslySetInnerHTML: { __html: "__NEXT_MAIN__" } }, void 0, false, {
    fileName: "/home/runner/work/vinext/vinext/packages/vinext/src/shims/document.tsx",
    lineNumber: 40,
    columnNumber: 10
  }, this);
}
function NextScript() {
  return /* @__PURE__ */ jsxDEV("span", { dangerouslySetInnerHTML: { __html: "<!-- __NEXT_SCRIPTS__ -->" } }, void 0, false, {
    fileName: "/home/runner/work/vinext/vinext/packages/vinext/src/shims/document.tsx",
    lineNumber: 49,
    columnNumber: 10
  }, this);
}
function Document() {
  return /* @__PURE__ */ jsxDEV(Html, { lang: "en", children: [
    /* @__PURE__ */ jsxDEV(Head, { children: /* @__PURE__ */ jsxDEV("meta", { name: "description", content: "A vinext test app" }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/_document.tsx",
      lineNumber: 7,
      columnNumber: 9
    }, this) }, void 0, false, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/_document.tsx",
      lineNumber: 6,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV("body", { className: "custom-body", children: [
      /* @__PURE__ */ jsxDEV(Main, {}, void 0, false, {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/_document.tsx",
        lineNumber: 10,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV(NextScript, {}, void 0, false, {
        fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/_document.tsx",
        lineNumber: 11,
        columnNumber: 9
      }, this)
    ] }, void 0, true, {
      fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/_document.tsx",
      lineNumber: 9,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/_document.tsx",
    lineNumber: 5,
    columnNumber: 5
  }, this);
}
const i18nConfig = null;
const vinextConfig = { "basePath": "", "trailingSlash": false, "redirects": [{ "source": "/old-about", "destination": "/about", "permanent": true }], "rewrites": { "beforeFiles": [{ "source": "/before-rewrite", "destination": "/about" }], "afterFiles": [{ "source": "/after-rewrite", "destination": "/about" }], "fallback": [{ "source": "/fallback-rewrite", "destination": "/about" }] }, "headers": [{ "source": "/api/(.*)", "headers": [{ "key": "X-Custom-Header", "value": "vinext" }] }], "i18n": null };
async function isrGet(key) {
  const handler2 = getCacheHandler();
  const result = await handler2.get(key);
  if (!result || !result.value) return null;
  return { value: result, isStale: result.cacheState === "stale" };
}
async function isrSet(key, data, revalidateSeconds, tags) {
  const handler2 = getCacheHandler();
  await handler2.set(key, data, { revalidate: revalidateSeconds, tags: [] });
}
const pendingRegenerations = /* @__PURE__ */ new Map();
function triggerBackgroundRegeneration(key, renderFn) {
  if (pendingRegenerations.has(key)) return;
  const promise = renderFn().catch((err) => console.error("[vinext] ISR regen failed for " + key + ":", err)).finally(() => pendingRegenerations.delete(key));
  pendingRegenerations.set(key, promise);
}
async function renderToStringAsync(element) {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}
const pageRoutes = [
  { pattern: "/", isDynamic: false, params: [], module: page_0, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/index.tsx" },
  { pattern: "/404", isDynamic: false, params: [], module: page_1, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/404.tsx" },
  { pattern: "/about", isDynamic: false, params: [], module: page_2, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/about.tsx" },
  { pattern: "/alias-test", isDynamic: false, params: [], module: page_3, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/alias-test.tsx" },
  { pattern: "/before-pop-state-test", isDynamic: false, params: [], module: page_4, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/before-pop-state-test.tsx" },
  { pattern: "/config-test", isDynamic: false, params: [], module: page_5, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/config-test.tsx" },
  { pattern: "/counter", isDynamic: false, params: [], module: page_6, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/counter.tsx" },
  { pattern: "/dynamic-page", isDynamic: false, params: [], module: page_7, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/dynamic-page.tsx" },
  { pattern: "/dynamic-ssr-false", isDynamic: false, params: [], module: page_8, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/dynamic-ssr-false.tsx" },
  { pattern: "/isr-test", isDynamic: false, params: [], module: page_9, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/isr-test.tsx" },
  { pattern: "/link-test", isDynamic: false, params: [], module: page_10, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/link-test.tsx" },
  { pattern: "/nav-test", isDynamic: false, params: [], module: page_11, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/nav-test.tsx" },
  { pattern: "/posts/missing", isDynamic: false, params: [], module: page_12, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/posts/missing.tsx" },
  { pattern: "/redirect-xss", isDynamic: false, params: [], module: page_13, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/redirect-xss.tsx" },
  { pattern: "/router-events-test", isDynamic: false, params: [], module: page_14, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/router-events-test.tsx" },
  { pattern: "/script-test", isDynamic: false, params: [], module: page_15, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/script-test.tsx" },
  { pattern: "/shallow-test", isDynamic: false, params: [], module: page_16, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/shallow-test.tsx" },
  { pattern: "/ssr", isDynamic: false, params: [], module: page_17, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/ssr.tsx" },
  { pattern: "/suspense-test", isDynamic: false, params: [], module: page_18, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/suspense-test.tsx" },
  { pattern: "/articles/:id", isDynamic: true, params: ["id"], module: page_19, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/articles/[id].tsx" },
  { pattern: "/blog/:slug", isDynamic: true, params: ["slug"], module: page_20, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/blog/[slug].tsx" },
  { pattern: "/posts/:id", isDynamic: true, params: ["id"], module: page_21, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/posts/[id].tsx" },
  { pattern: "/products/:pid", isDynamic: true, params: ["pid"], module: page_22, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/products/[pid].tsx" },
  { pattern: "/docs/:slug+", isDynamic: true, params: ["slug"], module: page_23, filePath: "/home/runner/work/vinext/vinext/tests/fixtures/pages-basic/pages/docs/[...slug].tsx" }
];
const apiRoutes = [
  { pattern: "/api/binary", isDynamic: false, params: [], module: api_0 },
  { pattern: "/api/hello", isDynamic: false, params: [], module: api_1 },
  { pattern: "/api/middleware-test", isDynamic: false, params: [], module: api_2 },
  { pattern: "/api/users/:id", isDynamic: true, params: ["id"], module: api_3 }
];
function matchRoute(url, routes) {
  const pathname = url.split("?")[0];
  let normalizedUrl = pathname === "/" ? "/" : pathname.replace(/\/$/, "");
  try {
    normalizedUrl = decodeURIComponent(normalizedUrl);
  } catch {
  }
  for (const route of routes) {
    const params = matchPattern(normalizedUrl, route.pattern);
    if (params !== null) return { route, params };
  }
  return null;
}
function matchPattern(url, pattern) {
  const urlParts = url.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  const params = /* @__PURE__ */ Object.create(null);
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    if (pp.endsWith("+")) {
      const paramName = pp.slice(1, -1);
      const remaining = urlParts.slice(i);
      if (remaining.length === 0) return null;
      params[paramName] = remaining;
      return params;
    }
    if (pp.endsWith("*")) {
      const paramName = pp.slice(1, -1);
      params[paramName] = urlParts.slice(i);
      return params;
    }
    if (pp.startsWith(":")) {
      if (i >= urlParts.length) return null;
      params[pp.slice(1)] = urlParts[i];
      continue;
    }
    if (i >= urlParts.length || urlParts[i] !== pp) return null;
  }
  if (urlParts.length !== patternParts.length) return null;
  return params;
}
function parseQuery(url) {
  const qs = url.split("?")[1];
  if (!qs) return {};
  const p = new URLSearchParams(qs);
  const q = {};
  for (const [k, v] of p) {
    if (k in q) {
      q[k] = Array.isArray(q[k]) ? q[k].concat(v) : [q[k], v];
    } else {
      q[k] = v;
    }
  }
  return q;
}
function patternToNextFormat(pattern) {
  return pattern.replace(/:([\w]+)\*/g, "[[...$1]]").replace(/:([\w]+)\+/g, "[...$1]").replace(/:([\w]+)/g, "[$1]");
}
function collectAssetTags(manifest, moduleIds) {
  const m = manifest && Object.keys(manifest).length > 0 ? manifest : typeof globalThis !== "undefined" && globalThis.__VINEXT_SSR_MANIFEST__ || null;
  const tags = [];
  const seen = /* @__PURE__ */ new Set();
  var lazyChunks = typeof globalThis !== "undefined" && globalThis.__VINEXT_LAZY_CHUNKS__ || null;
  var lazySet = lazyChunks && lazyChunks.length > 0 ? new Set(lazyChunks) : null;
  if (typeof globalThis !== "undefined" && globalThis.__VINEXT_CLIENT_ENTRY__) {
    const entry = globalThis.__VINEXT_CLIENT_ENTRY__;
    seen.add(entry);
    tags.push('<link rel="modulepreload" href="/' + entry + '" />');
    tags.push('<script type="module" src="/' + entry + '" crossorigin><\/script>');
  }
  if (m) {
    var allFiles = [];
    if (moduleIds && moduleIds.length > 0) {
      for (var mi = 0; mi < moduleIds.length; mi++) {
        var id = moduleIds[mi];
        var files = m[id];
        if (!files) {
          for (var mk in m) {
            if (id.endsWith("/" + mk) || id === mk) {
              files = m[mk];
              break;
            }
          }
        }
        if (files) {
          for (var fi = 0; fi < files.length; fi++) allFiles.push(files[fi]);
        }
      }
      for (var key in m) {
        var vals = m[key];
        if (!vals) continue;
        for (var vi = 0; vi < vals.length; vi++) {
          var file = vals[vi];
          var basename = file.split("/").pop() || "";
          if (basename.startsWith("framework-") || basename.startsWith("vinext-") || basename.includes("vinext-client-entry") || basename.includes("vinext-app-browser-entry")) {
            allFiles.push(file);
          }
        }
      }
    } else {
      for (var akey in m) {
        var avals = m[akey];
        if (avals) {
          for (var ai = 0; ai < avals.length; ai++) allFiles.push(avals[ai]);
        }
      }
    }
    for (var ti = 0; ti < allFiles.length; ti++) {
      var tf = allFiles[ti];
      if (tf.charAt(0) === "/") tf = tf.slice(1);
      if (seen.has(tf)) continue;
      seen.add(tf);
      if (tf.endsWith(".css")) {
        tags.push('<link rel="stylesheet" href="/' + tf + '" />');
      } else if (tf.endsWith(".js")) {
        if (lazySet && lazySet.has(tf)) continue;
        tags.push('<link rel="modulepreload" href="/' + tf + '" />');
        tags.push('<script type="module" src="/' + tf + '" crossorigin><\/script>');
      }
    }
  }
  return tags.join("\n  ");
}
function extractLocale(url) {
  return { locale: void 0, url, hadPrefix: false };
}
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.split("=");
    if (key) cookies[key.trim()] = rest.join("=").trim();
  }
  return cookies;
}
function createReqRes(request, url, query, body) {
  const headersObj = {};
  for (const [k, v] of request.headers) headersObj[k.toLowerCase()] = v;
  const req = {
    method: request.method,
    url,
    headers: headersObj,
    query,
    body,
    cookies: parseCookies(request.headers.get("cookie"))
  };
  let resStatusCode = 200;
  const resHeaders = {};
  const setCookieHeaders = [];
  let resBody = null;
  let ended = false;
  let resolveResponse;
  const responsePromise = new Promise(function(r) {
    resolveResponse = r;
  });
  const res = {
    get statusCode() {
      return resStatusCode;
    },
    set statusCode(code) {
      resStatusCode = code;
    },
    writeHead: function(code, headers) {
      resStatusCode = code;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === "set-cookie") {
            if (Array.isArray(v)) {
              for (const c of v) setCookieHeaders.push(c);
            } else {
              setCookieHeaders.push(v);
            }
          } else {
            resHeaders[k] = v;
          }
        }
      }
      return res;
    },
    setHeader: function(name, value) {
      if (name.toLowerCase() === "set-cookie") {
        if (Array.isArray(value)) {
          for (const c of value) setCookieHeaders.push(c);
        } else {
          setCookieHeaders.push(value);
        }
      } else {
        resHeaders[name.toLowerCase()] = value;
      }
      return res;
    },
    getHeader: function(name) {
      if (name.toLowerCase() === "set-cookie") return setCookieHeaders.length > 0 ? setCookieHeaders : void 0;
      return resHeaders[name.toLowerCase()];
    },
    end: function(data) {
      if (ended) return;
      ended = true;
      if (data !== void 0 && data !== null) resBody = data;
      const h = new Headers(resHeaders);
      for (const c of setCookieHeaders) h.append("set-cookie", c);
      resolveResponse(new Response(resBody, { status: resStatusCode, headers: h }));
    },
    status: function(code) {
      resStatusCode = code;
      return res;
    },
    json: function(data) {
      resHeaders["content-type"] = "application/json";
      res.end(JSON.stringify(data));
    },
    send: function(data) {
      if (typeof data === "object" && data !== null) {
        res.json(data);
      } else {
        if (!resHeaders["content-type"]) resHeaders["content-type"] = "text/plain";
        res.end(String(data));
      }
    },
    redirect: function(statusOrUrl, url2) {
      if (typeof statusOrUrl === "string") {
        res.writeHead(307, { Location: statusOrUrl });
      } else {
        res.writeHead(statusOrUrl, { Location: url2 });
      }
      res.end();
    }
  };
  return { req, res, responsePromise };
}
async function readBodyWithLimit(request, maxBytes) {
  if (!request.body) return "";
  var reader = request.body.getReader();
  var decoder = new TextDecoder();
  var chunks = [];
  var totalSize = 0;
  for (; ; ) {
    var result = await reader.read();
    if (result.done) break;
    totalSize += result.value.byteLength;
    if (totalSize > maxBytes) {
      reader.cancel();
      throw new Error("Request body too large");
    }
    chunks.push(decoder.decode(result.value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}
async function renderPage(request, url, manifest) {
  const localeInfo = extractLocale(url);
  const locale = localeInfo.locale;
  const routeUrl = localeInfo.url;
  request.headers.get("cookie") || "";
  const match = matchRoute(routeUrl, pageRoutes);
  if (!match) {
    return new Response(
      "<!DOCTYPE html><html><body><h1>404 - Page not found</h1></body></html>",
      { status: 404, headers: { "Content-Type": "text/html" } }
    );
  }
  const { route, params } = match;
  return runWithRouterState(
    () => runWithHeadState(
      () => _runWithCacheState(
        () => runWithPrivateCache(
          () => runWithFetchCache(async () => {
            try {
              let _escAttr = function(s) {
                return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
              };
              if (typeof setSSRContext === "function") {
                setSSRContext({
                  pathname: routeUrl.split("?")[0],
                  query: { ...params, ...parseQuery(routeUrl) },
                  asPath: routeUrl,
                  locale,
                  locales: i18nConfig ? i18nConfig.locales : void 0,
                  defaultLocale: i18nConfig ? i18nConfig.defaultLocale : void 0
                });
              }
              if (i18nConfig) ;
              const pageModule = route.module;
              const PageComponent = pageModule.default;
              if (!PageComponent) {
                return new Response("Page has no default export", { status: 500 });
              }
              if (typeof pageModule.getStaticPaths === "function" && route.isDynamic) {
                const pathsResult = await pageModule.getStaticPaths({
                  locales: i18nConfig ? i18nConfig.locales : [],
                  defaultLocale: i18nConfig ? i18nConfig.defaultLocale : ""
                });
                const fallback = pathsResult && pathsResult.fallback !== void 0 ? pathsResult.fallback : false;
                if (fallback === false) {
                  const paths = pathsResult && pathsResult.paths ? pathsResult.paths : [];
                  const isValidPath = paths.some(function(p) {
                    return Object.entries(p.params).every(function(entry) {
                      var key = entry[0], val = entry[1];
                      var actual = params[key];
                      if (Array.isArray(val)) {
                        return Array.isArray(actual) && val.join("/") === actual.join("/");
                      }
                      return String(val) === String(actual);
                    });
                  });
                  if (!isValidPath) {
                    return new Response(
                      "<!DOCTYPE html><html><body><h1>404 - Page not found</h1></body></html>",
                      { status: 404, headers: { "Content-Type": "text/html" } }
                    );
                  }
                }
              }
              let pageProps = {};
              if (typeof pageModule.getServerSideProps === "function") {
                const { req, res } = createReqRes(request, routeUrl, parseQuery(routeUrl), void 0);
                const ctx = {
                  params,
                  req,
                  res,
                  query: parseQuery(routeUrl),
                  resolvedUrl: routeUrl,
                  locale,
                  locales: i18nConfig ? i18nConfig.locales : void 0,
                  defaultLocale: i18nConfig ? i18nConfig.defaultLocale : void 0
                };
                const result = await pageModule.getServerSideProps(ctx);
                if (result && result.props) pageProps = result.props;
                if (result && result.redirect) {
                  var gsspStatus = result.redirect.statusCode != null ? result.redirect.statusCode : result.redirect.permanent ? 308 : 307;
                  return new Response(null, { status: gsspStatus, headers: { Location: sanitizeDestinationLocal(result.redirect.destination) } });
                }
                if (result && result.notFound) {
                  return new Response("404", { status: 404 });
                }
              }
              var _fontLinkHeader = "";
              var _allFp = [];
              try {
                var _fpGoogle = typeof getSSRFontPreloads$1 === "function" ? getSSRFontPreloads$1() : [];
                var _fpLocal = typeof getSSRFontPreloads === "function" ? getSSRFontPreloads() : [];
                _allFp = _fpGoogle.concat(_fpLocal);
                if (_allFp.length > 0) {
                  _fontLinkHeader = _allFp.map(function(p) {
                    return "<" + p.href + ">; rel=preload; as=font; type=" + p.type + "; crossorigin";
                  }).join(", ");
                }
              } catch (e) {
              }
              let isrRevalidateSeconds = null;
              if (typeof pageModule.getStaticProps === "function") {
                const pathname = routeUrl.split("?")[0];
                const cacheKey = "pages:" + (pathname === "/" ? "/" : pathname.replace(/\/$/, ""));
                const cached = await isrGet(cacheKey);
                if (cached && !cached.isStale && cached.value.value && cached.value.value.kind === "PAGES") {
                  var _hitHeaders = {
                    "Content-Type": "text/html",
                    "X-Vinext-Cache": "HIT",
                    "Cache-Control": "s-maxage=" + (cached.value.value.revalidate || 60) + ", stale-while-revalidate"
                  };
                  if (_fontLinkHeader) _hitHeaders["Link"] = _fontLinkHeader;
                  return new Response(cached.value.value.html, { status: 200, headers: _hitHeaders });
                }
                if (cached && cached.isStale && cached.value.value && cached.value.value.kind === "PAGES") {
                  triggerBackgroundRegeneration(cacheKey, async function() {
                    const freshResult = await pageModule.getStaticProps({ params });
                    if (freshResult && freshResult.props && typeof freshResult.revalidate === "number" && freshResult.revalidate > 0) {
                      await isrSet(cacheKey, { kind: "PAGES", html: cached.value.value.html, pageData: freshResult.props, headers: void 0, status: void 0 }, freshResult.revalidate);
                    }
                  });
                  var _staleHeaders = {
                    "Content-Type": "text/html",
                    "X-Vinext-Cache": "STALE",
                    "Cache-Control": "s-maxage=0, stale-while-revalidate"
                  };
                  if (_fontLinkHeader) _staleHeaders["Link"] = _fontLinkHeader;
                  return new Response(cached.value.value.html, { status: 200, headers: _staleHeaders });
                }
                const ctx = {
                  params,
                  locale,
                  locales: i18nConfig ? i18nConfig.locales : void 0,
                  defaultLocale: i18nConfig ? i18nConfig.defaultLocale : void 0
                };
                const result = await pageModule.getStaticProps(ctx);
                if (result && result.props) pageProps = result.props;
                if (result && result.redirect) {
                  var gspStatus = result.redirect.statusCode != null ? result.redirect.statusCode : result.redirect.permanent ? 308 : 307;
                  return new Response(null, { status: gspStatus, headers: { Location: sanitizeDestinationLocal(result.redirect.destination) } });
                }
                if (result && result.notFound) {
                  return new Response("404", { status: 404 });
                }
                if (typeof result.revalidate === "number" && result.revalidate > 0) {
                  isrRevalidateSeconds = result.revalidate;
                }
              }
              let element;
              if (MyApp) {
                element = React.createElement(MyApp, { Component: PageComponent, pageProps });
              } else {
                element = React.createElement(PageComponent, pageProps);
              }
              if (typeof resetSSRHead === "function") resetSSRHead();
              if (typeof flushPreloads === "function") await flushPreloads();
              const ssrHeadHTML = typeof getSSRHeadHTML === "function" ? getSSRHeadHTML() : "";
              var fontHeadHTML = "";
              try {
                var fontLinks = typeof getSSRFontLinks === "function" ? getSSRFontLinks() : [];
                for (var fl of fontLinks) {
                  fontHeadHTML += '<link rel="stylesheet" href="' + _escAttr(fl) + '" />\n  ';
                }
              } catch (e) {
              }
              for (var fp of _allFp) {
                fontHeadHTML += '<link rel="preload" href="' + _escAttr(fp.href) + '" as="font" type="' + _escAttr(fp.type) + '" crossorigin />\n  ';
              }
              try {
                var allFontStyles = [];
                if (typeof getSSRFontStyles$1 === "function") allFontStyles.push(...getSSRFontStyles$1());
                if (typeof getSSRFontStyles === "function") allFontStyles.push(...getSSRFontStyles());
                if (allFontStyles.length > 0) {
                  fontHeadHTML += "<style data-vinext-fonts>" + allFontStyles.join("\n") + "</style>\n  ";
                }
              } catch (e) {
              }
              const pageModuleIds = route.filePath ? [route.filePath] : [];
              const assetTags = collectAssetTags(manifest, pageModuleIds);
              const nextDataPayload = {
                props: { pageProps },
                page: patternToNextFormat(route.pattern),
                query: params,
                isFallback: false
              };
              if (i18nConfig) ;
              const localeGlobals = i18nConfig ? ";window.__VINEXT_LOCALE__=" + safeJsonStringify(locale) + ";window.__VINEXT_LOCALES__=" + safeJsonStringify(i18nConfig.locales) + ";window.__VINEXT_DEFAULT_LOCALE__=" + safeJsonStringify(i18nConfig.defaultLocale) : "";
              const nextDataScript = "<script>window.__NEXT_DATA__ = " + safeJsonStringify(nextDataPayload) + localeGlobals + "<\/script>";
              var BODY_MARKER = "<!--VINEXT_STREAM_BODY-->";
              var shellHtml;
              if (Document) {
                const docElement = React.createElement(Document);
                shellHtml = await renderToStringAsync(docElement);
                shellHtml = shellHtml.replace("__NEXT_MAIN__", BODY_MARKER);
                if (ssrHeadHTML || assetTags || fontHeadHTML) {
                  shellHtml = shellHtml.replace("</head>", "  " + fontHeadHTML + ssrHeadHTML + "\n  " + assetTags + "\n</head>");
                }
                shellHtml = shellHtml.replace("<!-- __NEXT_SCRIPTS__ -->", nextDataScript);
                if (!shellHtml.includes("__NEXT_DATA__")) {
                  shellHtml = shellHtml.replace("</body>", "  " + nextDataScript + "\n</body>");
                }
              } else {
                shellHtml = '<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  ' + fontHeadHTML + ssrHeadHTML + "\n  " + assetTags + '\n</head>\n<body>\n  <div id="__next">' + BODY_MARKER + "</div>\n  " + nextDataScript + "\n</body>\n</html>";
              }
              if (typeof setSSRContext === "function") setSSRContext(null);
              var markerIdx = shellHtml.indexOf(BODY_MARKER);
              var shellPrefix = shellHtml.slice(0, markerIdx);
              var shellSuffix = shellHtml.slice(markerIdx + BODY_MARKER.length);
              var bodyStream = await renderToReadableStream(element);
              var encoder = new TextEncoder();
              var compositeStream = new ReadableStream({
                async start(controller) {
                  controller.enqueue(encoder.encode(shellPrefix));
                  var reader = bodyStream.getReader();
                  try {
                    for (; ; ) {
                      var chunk = await reader.read();
                      if (chunk.done) break;
                      controller.enqueue(chunk.value);
                    }
                  } finally {
                    reader.releaseLock();
                  }
                  controller.enqueue(encoder.encode(shellSuffix));
                  controller.close();
                }
              });
              if (isrRevalidateSeconds !== null && isrRevalidateSeconds > 0) {
                var isrElement;
                if (MyApp) {
                  isrElement = React.createElement(MyApp, { Component: PageComponent, pageProps });
                } else {
                  isrElement = React.createElement(PageComponent, pageProps);
                }
                var isrHtml = await renderToStringAsync(isrElement);
                var fullHtml = shellPrefix + isrHtml + shellSuffix;
                var isrPathname = url.split("?")[0];
                var isrCacheKey = "pages:" + (isrPathname === "/" ? "/" : isrPathname.replace(/\/$/, ""));
                await isrSet(isrCacheKey, { kind: "PAGES", html: fullHtml, pageData: pageProps, headers: void 0, status: void 0 }, isrRevalidateSeconds);
              }
              const responseHeaders = { "Content-Type": "text/html" };
              if (isrRevalidateSeconds) {
                responseHeaders["Cache-Control"] = "s-maxage=" + isrRevalidateSeconds + ", stale-while-revalidate";
                responseHeaders["X-Vinext-Cache"] = "MISS";
              }
              if (_fontLinkHeader) {
                responseHeaders["Link"] = _fontLinkHeader;
              }
              return new Response(compositeStream, { status: 200, headers: responseHeaders });
            } catch (e) {
              console.error("[vinext] SSR error:", e);
              return new Response("Internal Server Error", { status: 500 });
            }
          })
          // end runWithFetchCache
        )
        // end runWithPrivateCache
      )
      // end _runWithCacheState
    )
    // end runWithHeadState
  );
}
async function handleApiRoute(request, url) {
  const match = matchRoute(url, apiRoutes);
  if (!match) {
    return new Response("404 - API route not found", { status: 404 });
  }
  const { route, params } = match;
  const handler2 = route.module.default;
  if (typeof handler2 !== "function") {
    return new Response("API route does not export a default function", { status: 500 });
  }
  const query = { ...params };
  const qs = url.split("?")[1];
  if (qs) {
    for (const [k, v] of new URLSearchParams(qs)) {
      if (k in query) {
        query[k] = Array.isArray(query[k]) ? query[k].concat(v) : [query[k], v];
      } else {
        query[k] = v;
      }
    }
  }
  const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > 1 * 1024 * 1024) {
    return new Response("Request body too large", { status: 413 });
  }
  let body;
  const ct = request.headers.get("content-type") || "";
  let rawBody;
  try {
    rawBody = await readBodyWithLimit(request, 1 * 1024 * 1024);
  } catch {
    return new Response("Request body too large", { status: 413 });
  }
  if (!rawBody) {
    body = void 0;
  } else if (ct.includes("application/json")) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }
  } else {
    body = rawBody;
  }
  const { req, res, responsePromise } = createReqRes(request, url, query, body);
  try {
    await handler2(req, res);
    res.end();
    return await responsePromise;
  } catch (e) {
    console.error("[vinext] API error:", e);
    return new Response("Internal Server Error", { status: 500 });
  }
}
function __normalizePath(pathname) {
  if (pathname === "/" || pathname.length > 1 && pathname[0] === "/" && !pathname.includes("//") && !pathname.includes("/./") && !pathname.includes("/../") && !pathname.endsWith("/.") && !pathname.endsWith("/..")) {
    return pathname;
  }
  var segments = pathname.split("/");
  var resolved = [];
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      resolved.pop();
    } else {
      resolved.push(seg);
    }
  }
  return "/" + resolved.join("/");
}
function __isSafeRegex(pattern) {
  var quantifierAtDepth = [];
  var depth = 0;
  var i = 0;
  while (i < pattern.length) {
    var ch = pattern[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "(") {
      depth++;
      if (quantifierAtDepth.length <= depth) quantifierAtDepth.push(false);
      else quantifierAtDepth[depth] = false;
      i++;
      continue;
    }
    if (ch === ")") {
      var hadQ = depth > 0 && quantifierAtDepth[depth];
      if (depth > 0) depth--;
      var next = pattern[i + 1];
      if (next === "+" || next === "*" || next === "{") {
        if (hadQ) return false;
        if (depth >= 0 && depth < quantifierAtDepth.length) quantifierAtDepth[depth] = true;
      }
      i++;
      continue;
    }
    if (ch === "+" || ch === "*") {
      if (depth > 0) quantifierAtDepth[depth] = true;
      i++;
      continue;
    }
    if (ch === "?") {
      var prev = i > 0 ? pattern[i - 1] : "";
      if (prev !== "+" && prev !== "*" && prev !== "?" && prev !== "}") {
        if (depth > 0) quantifierAtDepth[depth] = true;
      }
      i++;
      continue;
    }
    if (ch === "{") {
      var j = i + 1;
      while (j < pattern.length && /[\d,]/.test(pattern[j])) j++;
      if (j < pattern.length && pattern[j] === "}" && j > i + 1) {
        if (depth > 0) quantifierAtDepth[depth] = true;
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return true;
}
function __safeRegExp(pattern, flags) {
  if (!__isSafeRegex(pattern)) {
    console.warn("[vinext] Ignoring potentially unsafe regex pattern (ReDoS risk): " + pattern);
    return null;
  }
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}
function matchMiddlewarePattern(pathname, pattern) {
  if (pattern.includes("(") || pattern.includes("\\")) {
    var re = __safeRegExp("^" + pattern + "$");
    if (re) return re.test(pathname);
  }
  var regexStr = "";
  var tokenRe = /\/:([\w]+)\*|\/:([\w]+)\+|:([\w]+)|[.]|[^/:.]+|./g;
  var tok;
  while ((tok = tokenRe.exec(pattern)) !== null) {
    if (tok[1] !== void 0) {
      regexStr += "(?:/.*)?";
    } else if (tok[2] !== void 0) {
      regexStr += "(?:/.+)";
    } else if (tok[3] !== void 0) {
      regexStr += "([^/]+)";
    } else if (tok[0] === ".") {
      regexStr += "\\.";
    } else {
      regexStr += tok[0];
    }
  }
  var re2 = __safeRegExp("^" + regexStr + "$");
  return re2 ? re2.test(pathname) : pathname === pattern;
}
function matchesMiddleware(pathname, matcher) {
  if (!matcher) {
    return true;
  }
  var patterns = [];
  if (typeof matcher === "string") {
    patterns.push(matcher);
  } else if (Array.isArray(matcher)) {
    for (var m of matcher) {
      if (typeof m === "string") patterns.push(m);
      else if (m && typeof m === "object" && "source" in m) patterns.push(m.source);
    }
  }
  return patterns.some(function(p) {
    return matchMiddlewarePattern(pathname, p);
  });
}
async function runMiddleware(request) {
  var middlewareFn = middleware;
  if (typeof middlewareFn !== "function") return { continue: true };
  var config$1 = config;
  var matcher = config$1 && config$1.matcher;
  var url = new URL(request.url);
  var decodedPathname;
  try {
    decodedPathname = decodeURIComponent(url.pathname);
  } catch (e) {
    return { continue: false, response: new Response("Bad Request", { status: 400 }) };
  }
  var normalizedPathname = __normalizePath(decodedPathname);
  if (!matchesMiddleware(normalizedPathname, matcher)) return { continue: true };
  var nextRequest = request instanceof NextRequest ? request : new NextRequest(request);
  var response;
  try {
    response = await middlewareFn(nextRequest);
  } catch (e) {
    console.error("[vinext] Middleware error:", e);
    return { continue: false, response: new Response("Internal Server Error", { status: 500 }) };
  }
  if (!response) return { continue: true };
  if (response.headers.get("x-middleware-next") === "1") {
    var rHeaders = new Headers();
    for (var [key, value] of response.headers) {
      if (key !== "x-middleware-next" && key !== "x-middleware-rewrite") rHeaders.set(key, value);
    }
    return { continue: true, responseHeaders: rHeaders };
  }
  if (response.status >= 300 && response.status < 400) {
    var location = response.headers.get("Location") || response.headers.get("location");
    if (location) return { continue: false, redirectUrl: location, redirectStatus: response.status };
  }
  var rewriteUrl = response.headers.get("x-middleware-rewrite");
  if (rewriteUrl) {
    var rwHeaders = new Headers();
    for (var [k, v] of response.headers) {
      if (k !== "x-middleware-rewrite") rwHeaders.set(k, v);
    }
    var rewritePath;
    try {
      var parsed = new URL(rewriteUrl, request.url);
      rewritePath = parsed.pathname + parsed.search;
    } catch {
      rewritePath = rewriteUrl;
    }
    return { continue: true, rewriteUrl: rewritePath, rewriteStatus: response.status !== 200 ? response.status : void 0, responseHeaders: rwHeaders };
  }
  return { continue: false, response };
}
export {
  handleApiRoute,
  renderPage,
  runMiddleware,
  vinextConfig
};
