import {
  VINEXT_PRERENDER_NOT_FOUND_RENDER_ERROR,
  VINEXT_PRERENDER_RENDER_ERROR_HEADER,
  VINEXT_PRERENDER_SECRET_HEADER,
} from "./headers.js";
import { cloneRequestWithHeaders, cloneRequestWithUrl } from "./request-pipeline.js";

type PagesNotFoundI18nConfig = {
  defaultLocale: string;
  locales: readonly string[];
};

/**
 * Answer the prerender's not-found endpoint with the Pages Router's 404 page
 * (`pages/404`, else `_error`) for its `?locale=`, rendered on its own like
 * `next build` prerendering `/404`, never through redirects, middleware,
 * rewrites or a route that would answer a nonexistent path. A throw from the
 * render is the 404 page's own render error.
 */
export async function renderPagesPrerenderNotFound(
  request: Request,
  i18nConfig: PagesNotFoundI18nConfig | null | undefined,
  render: (renderRequest: Request, renderPath: string) => Promise<Response>,
): Promise<Response> {
  const locale = new URL(request.url).searchParams.get("locale");
  if (locale !== null && !i18nConfig?.locales.includes(locale)) {
    return new Response("Bad Request", { status: 400 });
  }
  const renderPath =
    locale !== null && locale !== i18nConfig?.defaultLocale ? `/${locale}/404` : "/404";
  const renderRequest = cloneRequestWithUrl(request, new URL(renderPath, request.url).href);
  // Like the Pages request stage, never pass the build's secret to user code.
  const headers = new Headers(renderRequest.headers);
  headers.delete(VINEXT_PRERENDER_SECRET_HEADER);
  try {
    return await render(cloneRequestWithHeaders(renderRequest, headers), renderPath);
  } catch (error) {
    console.error("[vinext] Server error:", error);
    return new Response("Internal Server Error", {
      status: 500,
      headers: { [VINEXT_PRERENDER_RENDER_ERROR_HEADER]: VINEXT_PRERENDER_NOT_FOUND_RENDER_ERROR },
    });
  }
}
