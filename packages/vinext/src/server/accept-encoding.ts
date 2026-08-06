import zlib from "node:zlib";
import { type IncomingMessage } from "node:http";

type ContentEncoding = "zstd" | "br" | "gzip" | "deflate";
export type NegotiatedEncoding = ContentEncoding | "identity";

/** Parsed explicit coding qualities plus the wildcard quality, when present. */
export type ParsedAcceptEncoding = {
  qualities: Map<string, number>;
  orders: Map<string, number>;
  wildcardQuality: number | null;
};

/** Parse an Accept-Encoding header into exact-token numeric qualities. */
export function parseAcceptedEncodings(accept: string): ParsedAcceptEncoding {
  const qualities = new Map<string, number>();
  const orders = new Map<string, number>();
  let wildcardQuality: number | null = null;

  for (const [order, part] of accept.split(",").entries()) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;

    const semi = trimmed.indexOf(";");
    const token = (semi === -1 ? trimmed : trimmed.slice(0, semi)).trim().toLowerCase();
    if (token.length === 0) continue;

    let quality = 1;
    if (semi !== -1) {
      let qStr: string | undefined;
      for (const param of trimmed.slice(semi + 1).split(";")) {
        const trimmedParam = param.trim();
        const [name, value] = trimmedParam.split("=");
        if (name !== "q") continue;
        qStr = value ?? "";
        break;
      }
      if (qStr !== undefined) {
        quality = Number.parseFloat(qStr);
      }
    }

    if (token === "*") {
      if (
        wildcardQuality === null ||
        Number.isNaN(quality) ||
        Number.isNaN(wildcardQuality) ||
        quality >= wildcardQuality
      ) {
        wildcardQuality = quality;
      }
    } else {
      const currentQuality = qualities.get(token);
      if (
        currentQuality === undefined ||
        Number.isNaN(quality) ||
        Number.isNaN(currentQuality) ||
        quality >= currentQuality
      ) {
        qualities.set(token, quality);
        orders.set(token, order);
      }
    }
  }

  return { qualities, orders, wildcardQuality };
}

/** Return the effective quality for a coding, including wildcard/identity rules. */
export function getEncodingQuality(parsed: ParsedAcceptEncoding, encoding: string): number {
  const normalized = encoding.toLowerCase();
  const explicit = parsed.qualities.get(normalized);
  if (explicit !== undefined) return Number.isNaN(explicit) ? 0 : explicit;
  if (normalized === "identity") return parsed.wildcardQuality === 0 ? 0 : 1;
  if (parsed.wildcardQuality !== null) {
    return Number.isNaN(parsed.wildcardQuality) ? 0 : parsed.wildcardQuality;
  }
  return 0;
}

export function isEncodingAccepted(parsed: ParsedAcceptEncoding, encoding: string): boolean {
  return getEncodingQuality(parsed, encoding) > 0;
}

/** Choose the highest-quality available coding, using array order as the tie-breaker. */
export function selectAcceptedEncoding<T extends string>(
  parsed: ParsedAcceptEncoding,
  available: readonly T[],
): T | null {
  let selected: T | null = null;
  let selectedQuality = 0;
  for (const encoding of available) {
    const quality = getEncodingQuality(parsed, encoding);
    if (quality > selectedQuality) {
      selected = encoding;
      selectedQuality = quality;
    }
  }
  return selected;
}

/**
 * Select a content coding while matching Next.js's compression middleware:
 * an explicit identity preference can win, but implicit identity remains a
 * fallback rather than suppressing an otherwise acceptable encoding.
 */
export function selectContentEncoding<T extends ContentEncoding>(
  parsed: ParsedAcceptEncoding,
  available: readonly T[],
): T | "identity" {
  const selected = selectAcceptedEncoding(parsed, available);
  if (selected === null) return "identity";

  const identityQuality = parsed.qualities.get("identity");
  if (identityQuality === undefined || Number.isNaN(identityQuality)) return selected;

  const selectedQuality = getEncodingQuality(parsed, selected);
  if (identityQuality > selectedQuality) return "identity";
  if (identityQuality < selectedQuality) return selected;

  if (!parsed.qualities.has(selected)) return "identity";

  const identityOrder = parsed.orders.get("identity") ?? Number.POSITIVE_INFINITY;
  const selectedOrder = parsed.orders.get(selected) ?? Number.POSITIVE_INFINITY;
  return identityOrder < selectedOrder ? "identity" : selected;
}

export const HAS_ZSTD = typeof zlib.createZstdCompress === "function";

/** Select by client q-value first, then zstd > br > gzip > deflate > identity. */
export function negotiateEncoding(req: IncomingMessage): NegotiatedEncoding {
  const accept = req.headers["accept-encoding"];
  if (typeof accept !== "string") return "identity";
  const parsed = parseAcceptedEncodings(accept);
  return selectContentEncoding(parsed, [
    ...(HAS_ZSTD ? (["zstd"] as const) : []),
    "br",
    "gzip",
    "deflate",
  ]);
}
