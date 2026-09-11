import type {
  CdnCacheAdapter,
  CdnCacheableHeaderInput,
  CdnResponseHeaders,
} from "vinext/shims/cdn-cache";

import createCloudflareCdnCacheAdapter from "./cdn-adapter.runtime.js";
import {
  captureResponseStoreRscData,
  deferResponseStoreAdmission,
} from "./response-store-data.runtime.js";

/** Response Store owns page serving and SWR; vinext only emits admitted response policy. */
class ResponseStoreCdnCacheAdapter implements CdnCacheAdapter {
  readonly ownsBackgroundRevalidation = false;
  readonly requiresCompletedResponseAdmission = true;
  readonly responsePolicy: CdnCacheAdapter["responsePolicy"];

  constructor(private readonly headers: CdnCacheAdapter) {
    this.responsePolicy = headers.responsePolicy;
  }

  get(...args: Parameters<CdnCacheAdapter["get"]>) {
    return this.headers.get(...args);
  }
  set(...args: Parameters<CdnCacheAdapter["set"]>) {
    return this.headers.set(...args);
  }
  validateRequest(request: Request) {
    return this.headers.validateRequest?.(request) ?? null;
  }
  buildResponseIdentityHeaders(): CdnResponseHeaders {
    return this.headers.buildResponseIdentityHeaders?.() ?? {};
  }
  buildResponseHeaders(input: CdnCacheableHeaderInput): CdnResponseHeaders {
    return this.headers.buildResponseHeaders(input);
  }
  deferCompletedPageResponseAdmission(
    response: Response,
    complete: (response: Response) => Promise<Response>,
  ): Response | null {
    return deferResponseStoreAdmission(response, complete);
  }
  captureAppPageRscData(rscData: Promise<ArrayBuffer>): void {
    captureResponseStoreRscData(rscData);
  }
  async revalidateTag(): Promise<void> {
    // The unified data adapter invalidates both response and data entries in
    // the same Response Store, so doing it again here would duplicate work.
  }
}

export default function createResponseStoreCdnCacheAdapter(
  context: Parameters<typeof createCloudflareCdnCacheAdapter>[0],
): CdnCacheAdapter {
  return new ResponseStoreCdnCacheAdapter(createCloudflareCdnCacheAdapter(context));
}
