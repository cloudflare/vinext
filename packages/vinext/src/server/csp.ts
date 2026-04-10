import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

const ESCAPE_REGEX = /[&><\u2028\u2029]/;
type NodeHeaders = IncomingHttpHeaders | OutgoingHttpHeaders;

function matchesDirectiveName(directive: string, name: string): boolean {
  return directive === name || directive.startsWith(`${name} `);
}

function getNodeHeaderValue(
  headers: NodeHeaders | null | undefined,
  key: "content-security-policy" | "content-security-policy-report-only",
): string | undefined {
  const value = headers?.[key];
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (value == null) {
    return undefined;
  }
  return String(value);
}

export function getScriptNonceFromHeader(cspHeaderValue: string): string | undefined {
  const directives = cspHeaderValue.split(";").map((directive) => directive.trim());

  const directive =
    directives.find((value) => matchesDirectiveName(value, "script-src")) ??
    directives.find((value) => matchesDirectiveName(value, "default-src"));

  if (!directive) {
    return undefined;
  }

  const nonce = directive
    .split(" ")
    .slice(1)
    .map((source) => source.trim())
    .find((source) => source.startsWith("'nonce-") && source.length > 8 && source.endsWith("'"))
    ?.slice(7, -1);

  if (!nonce) {
    return undefined;
  }

  if (ESCAPE_REGEX.test(nonce)) {
    throw new Error(
      "Nonce value from Content-Security-Policy contained HTML escape characters.\nLearn more: https://nextjs.org/docs/messages/nonce-contained-invalid-characters",
    );
  }

  return nonce;
}

export function getScriptNonceFromHeaders(headers: Headers | null | undefined): string | undefined {
  const csp =
    headers?.get("content-security-policy") ?? headers?.get("content-security-policy-report-only");

  if (!csp) {
    return undefined;
  }

  return getScriptNonceFromHeader(csp);
}

export function getScriptNonceFromNodeHeaders(
  headers: NodeHeaders | null | undefined,
): string | undefined {
  const csp =
    getNodeHeaderValue(headers, "content-security-policy") ??
    getNodeHeaderValue(headers, "content-security-policy-report-only");

  if (!csp) {
    return undefined;
  }

  return getScriptNonceFromHeader(csp);
}

export function getScriptNonceFromNodeHeaderSources(
  ...headersList: readonly (NodeHeaders | null | undefined)[]
): string | undefined {
  for (const headers of headersList) {
    const nonce = getScriptNonceFromNodeHeaders(headers);
    if (nonce) {
      return nonce;
    }
  }

  return undefined;
}

export function getScriptNonceFromHeaderSources(
  ...headersList: readonly (Headers | null | undefined)[]
): string | undefined {
  for (const headers of headersList) {
    const nonce = getScriptNonceFromHeaders(headers);
    if (nonce) {
      return nonce;
    }
  }

  return undefined;
}
