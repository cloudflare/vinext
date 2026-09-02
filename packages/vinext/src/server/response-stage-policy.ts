import { mergeVaryHeader } from "./middleware-response-headers.js";
import { preserveFullyBufferedBodyMetadata } from "vinext/shims/unified-request-context";
import {
  PAGES_RESPONSE_STAGE_POLICY_OWNER_HEADER,
  type PagesResponseStagePolicyOwner,
} from "./worker-stages.js";

/** Apply request-stage cache policy before response-stage admission. */
export function applyResponseStagePolicyHeaders(
  headers: Headers,
  policyHeaders: ReadonlyArray<readonly [string, string]> | null | undefined,
): void {
  for (const [name, value] of policyHeaders ?? []) {
    if (name.toLowerCase() === "vary") {
      mergeVaryHeader(headers, value);
    } else {
      headers.set(name, value);
    }
  }
}

/**
 * Remove the copy of staged cookies that a response handler inherited before
 * it ran. The request stage composes those cookies again after transport, so
 * retaining the inherited copies would emit them twice. Multiset subtraction
 * preserves additional identical cookies deliberately appended by user code.
 */
export function stripInheritedResponseStageCookies(
  response: Response,
  stagedHeaders: Headers,
): Response {
  const stagedCookies = stagedHeaders.getSetCookie();
  if (stagedCookies.length === 0) return response;

  const responseCookies = response.headers.getSetCookie();
  let removed = false;
  for (const stagedCookie of stagedCookies) {
    const index = responseCookies.indexOf(stagedCookie);
    if (index === -1) continue;
    responseCookies.splice(index, 1);
    removed = true;
  }
  if (!removed) return response;

  const headers = new Headers(response.headers);
  headers.delete("Set-Cookie");
  for (const cookie of responseCookies) headers.append("Set-Cookie", cookie);
  return preserveFullyBufferedBodyMetadata(
    response,
    new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    }),
  );
}

/** Replace transported Vary fields with the effective request-stage value. */
export function withResponseStageVary(
  policyHeaders: ReadonlyArray<readonly [string, string]> | null | undefined,
  vary: string | null | undefined,
): Array<[string, string]> | null {
  const result: Array<[string, string]> = [];
  const varyHeaders = new Headers();
  for (const [name, value] of policyHeaders ?? []) {
    if (name.toLowerCase() === "vary") mergeVaryHeader(varyHeaders, value);
    else result.push([name, value]);
  }
  if (vary) mergeVaryHeader(varyHeaders, vary);
  const effectiveVary = varyHeaders.get("Vary");
  if (effectiveVary) result.push(["Vary", effectiveVary]);
  return result.length > 0 ? result : null;
}
/** Keep request-stage-only variance outside a reusable response artifact. */
export function withoutResponseStageVary(
  policyHeaders: ReadonlyArray<readonly [string, string]> | null | undefined,
): Array<[string, string]> | null {
  const result = (policyHeaders ?? []).filter(([name]) => name.toLowerCase() !== "vary");
  return result.length > 0 ? result.map(([name, value]) => [name, value]) : null;
}

/** Recompose additive request-stage headers before the rendered response values. */
export function prependResponseStageAdditiveHeaders(
  responseHeaders: Headers,
  outerHeaders: Headers,
): void {
  const outerLink = outerHeaders.get("link");
  if (outerLink) {
    const responseLink = responseHeaders.get("link");
    responseHeaders.set("link", responseLink ? `${outerLink}, ${responseLink}` : outerLink);
  }

  const outerVary = outerHeaders.get("vary");
  if (outerVary) {
    const responseVary = responseHeaders.get("vary");
    responseHeaders.delete("vary");
    mergeVaryHeader(responseHeaders, outerVary);
    if (responseVary) mergeVaryHeader(responseHeaders, responseVary);
  }
}

/** Consume trusted Pages response-stage policy ownership before public egress. */
export function consumePagesResponseStagePolicyOwner(response: Response): {
  owner: PagesResponseStagePolicyOwner | null;
  response: Response;
} {
  const value = response.headers.get(PAGES_RESPONSE_STAGE_POLICY_OWNER_HEADER);
  const owner = value === "request-time" || value === "static" ? value : null;
  if (value === null) return { owner, response };

  const headers = new Headers(response.headers);
  headers.delete(PAGES_RESPONSE_STAGE_POLICY_OWNER_HEADER);
  return {
    owner,
    response: preserveFullyBufferedBodyMetadata(
      response,
      new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      }),
    ),
  };
}
