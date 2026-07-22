import type { NextRouter } from "../upstream/router";

export { default, useRouter, withRouter } from "../upstream/router";
export type { NextRouter, RouterEvent, SingletonRouter } from "../upstream/router";

/**
 * The documented Router class surface implemented by vinext.
 *
 * Next.js's declaration also exposes implementation internals such as its
 * PageLoader and route-info cache. Vinext uses Vite's module graph instead,
 * so those internals are intentionally absent rather than falsely typed.
 */
export declare class Router {
  static events: NextRouter["events"];

  constructor(...args: unknown[]);

  route: NextRouter["route"];
  pathname: NextRouter["pathname"];
  query: NextRouter["query"];
  asPath: NextRouter["asPath"];
  basePath: NextRouter["basePath"];
  locale: NextRouter["locale"];
  locales: NextRouter["locales"];
  defaultLocale: NextRouter["defaultLocale"];
  domainLocales: NextRouter["domainLocales"];
  isLocaleDomain: NextRouter["isLocaleDomain"];
  isReady: NextRouter["isReady"];
  isPreview: NextRouter["isPreview"];
  isFallback: NextRouter["isFallback"];
  events: NextRouter["events"];

  push: NextRouter["push"];
  replace: NextRouter["replace"];
  reload: NextRouter["reload"];
  back: NextRouter["back"];
  forward: NextRouter["forward"];
  prefetch: NextRouter["prefetch"];
  beforePopState: NextRouter["beforePopState"];
}
