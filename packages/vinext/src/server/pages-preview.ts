import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { parseCookieHeader } from "../utils/parse-cookie.js";

export const PAGES_PREVIEW_CACHE_CONTROL =
  "private, no-cache, no-store, max-age=0, must-revalidate";

export type PagesPreviewData = object | string;
export type PagesPreviewState = {
  data: PagesPreviewData | false;
  shouldClear: boolean;
};

type PreviewResponse = {
  getHeader(name: string): string | number | boolean | string[] | undefined;
  setHeader(name: string, value: string | number | boolean | string[]): unknown;
};

const pagesPreviewCookiesCleared = Symbol("__prerender_bypass");

type PagesPreviewCredentials = {
  bypassId: string;
  encryptionKey: Buffer;
  signingKey: Buffer;
};

let devCredentials: PagesPreviewCredentials | undefined;

function decodeKey(value: string | undefined): Buffer | null {
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) return null;
  return Buffer.from(value, "hex");
}

function getPagesPreviewCredentials(): PagesPreviewCredentials {
  const bypassId = process.env.__VINEXT_PREVIEW_MODE_ID;
  const encryptionKey = decodeKey(process.env.__VINEXT_PREVIEW_MODE_ENCRYPTION_KEY);
  const signingKey = decodeKey(process.env.__VINEXT_PREVIEW_MODE_SIGNING_KEY);
  if (bypassId && encryptionKey && signingKey) return { bypassId, encryptionKey, signingKey };

  if (!devCredentials) {
    devCredentials = {
      bypassId: randomBytes(16).toString("hex"),
      encryptionKey: randomBytes(32),
      signingKey: randomBytes(32),
    };
  }
  return devCredentials;
}

export function getPagesPreviewModeId(): string {
  return getPagesPreviewCredentials().bypassId;
}

function serializeCookie(
  name: "__prerender_bypass" | "__next_preview_data",
  value: string,
  options: { maxAge?: number; path?: string } = {},
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    `Path=${options.path ?? "/"}`,
    process.env.NODE_ENV !== "development" ? "SameSite=None" : "SameSite=Lax",
  ];
  if (process.env.NODE_ENV !== "development") parts.push("Secure");
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.trunc(options.maxAge)}`);
  return parts.join("; ");
}

function serializeClearedCookie(
  name: "__prerender_bypass" | "__next_preview_data",
  options: { path?: string } = {},
): string {
  return [
    `${name}=`,
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    `Path=${options.path ?? "/"}`,
    process.env.NODE_ENV !== "development" ? "SameSite=None" : "SameSite=Lax",
    ...(process.env.NODE_ENV !== "development" ? ["Secure"] : []),
  ].join("; ");
}

function normalizeSetCookie(value: string | number | boolean | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function encodePayload(data: PagesPreviewData, maxAge?: number): string {
  const iv = randomBytes(12);
  const credentials = getPagesPreviewCredentials();
  const cipher = createCipheriv("aes-256-gcm", credentials.encryptionKey, iv);
  const plaintext = JSON.stringify({
    data,
    ...(maxAge === undefined ? {} : { expiresAt: Date.now() + maxAge * 1000 }),
  });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const encryptedToken = [iv, encrypted, cipher.getAuthTag()]
    .map((part) => part.toString("base64url"))
    .join(".");
  const signature = createHmac("sha256", credentials.signingKey)
    .update(encryptedToken)
    .digest("base64url");
  return `${encryptedToken}.${signature}`;
}

function decodePayload(payload: string): PagesPreviewData | false {
  try {
    const [ivValue, encryptedValue, tagValue, signatureValue, ...extra] = payload.split(".");
    if (!ivValue || !encryptedValue || !tagValue || !signatureValue || extra.length > 0) {
      return false;
    }
    const encryptedToken = `${ivValue}.${encryptedValue}.${tagValue}`;
    const credentials = getPagesPreviewCredentials();
    const expected = createHmac("sha256", credentials.signingKey).update(encryptedToken).digest();
    const signature = Buffer.from(signatureValue, "base64url");
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return false;

    const decipher = createDecipheriv(
      "aes-256-gcm",
      credentials.encryptionKey,
      Buffer.from(ivValue, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const decoded = Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const value: unknown = JSON.parse(decoded);
    if (typeof value !== "object" || value === null || !("data" in value)) return false;
    const expiresAt = "expiresAt" in value ? value.expiresAt : undefined;
    if (typeof expiresAt === "number" && Date.now() >= expiresAt) return false;
    const data = value.data;
    return typeof data === "object" && data !== null ? (data as object) : String(data);
  } catch {
    return false;
  }
}

export function getPagesPreviewState(
  cookieHeader: string | string[] | null | undefined,
  options: { isOnDemandRevalidate?: boolean } = {},
): PagesPreviewState {
  if (options.isOnDemandRevalidate) return { data: false, shouldClear: false };
  const cookies = parseCookieHeader(
    Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader,
  );
  const bypass = cookies.__prerender_bypass;
  const payload = cookies.__next_preview_data;
  if (!bypass && !payload) return { data: false, shouldClear: false };
  if (!bypass || bypass !== getPagesPreviewCredentials().bypassId) {
    return { data: false, shouldClear: true };
  }
  if (!payload) return { data: {}, shouldClear: false };
  const data = decodePayload(payload);
  return { data, shouldClear: data === false };
}

export function setPagesDraftMode(response: PreviewResponse, enabled: boolean): void {
  const cookie = enabled
    ? serializeCookie("__prerender_bypass", getPagesPreviewModeId())
    : serializeClearedCookie("__prerender_bypass");
  response.setHeader("Set-Cookie", [
    ...normalizeSetCookie(response.getHeader("Set-Cookie")),
    cookie,
  ]);
}

export function setPagesPreviewData(
  response: PreviewResponse,
  data: PagesPreviewData,
  options: { maxAge?: number; path?: string } = {},
): void {
  const payload = encodePayload(data, options.maxAge);
  if (payload.length > 2048) {
    throw new Error(
      "Preview data is limited to 2KB currently, reduce how much data you are storing as preview data to continue",
    );
  }
  response.setHeader("Set-Cookie", [
    ...normalizeSetCookie(response.getHeader("Set-Cookie")),
    serializeCookie("__prerender_bypass", getPagesPreviewModeId(), options),
    serializeCookie("__next_preview_data", payload, options),
  ]);
}

export function clearPagesPreviewData(
  response: PreviewResponse,
  options: { path?: string } = {},
): void {
  if (pagesPreviewCookiesCleared in response) return;

  response.setHeader("Set-Cookie", [
    ...normalizeSetCookie(response.getHeader("Set-Cookie")),
    serializeClearedCookie("__prerender_bypass", options),
    serializeClearedCookie("__next_preview_data", options),
  ]);
  Object.defineProperty(response, pagesPreviewCookiesCleared, {
    value: true,
    enumerable: false,
  });
}

export function appendPagesPreviewClearCookies(headers: Headers): void {
  const cookies = headers.getSetCookie();
  const hasExpiredCookie = (name: "__prerender_bypass" | "__next_preview_data") =>
    cookies.some((cookie) => {
      const [cookieValue, ...attributes] = cookie.split(";").map((part) => part.trim());
      if (!cookieValue?.startsWith(`${name}=`)) return false;

      let expiresAtEpoch = false;
      let path: string | undefined;
      let hasDomain = false;
      for (const attribute of attributes) {
        const separator = attribute.indexOf("=");
        const attributeName = (separator === -1 ? attribute : attribute.slice(0, separator))
          .trim()
          .toLowerCase();
        const attributeValue = separator === -1 ? "" : attribute.slice(separator + 1).trim();
        if (attributeName === "expires") expiresAtEpoch = Date.parse(attributeValue) === 0;
        if (attributeName === "path") path = attributeValue;
        if (attributeName === "domain") hasDomain = true;
      }

      return expiresAtEpoch && path === "/" && !hasDomain;
    });
  if (!hasExpiredCookie("__prerender_bypass")) {
    headers.append("Set-Cookie", serializeClearedCookie("__prerender_bypass"));
  }
  if (!hasExpiredCookie("__next_preview_data")) {
    headers.append("Set-Cookie", serializeClearedCookie("__next_preview_data"));
  }
}
