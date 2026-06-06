import { createInlineScriptTag, safeJsonStringify } from "./html.js";

export type InitialDevServerErrorPayload = {
  message: string;
  name?: string;
  stack?: string;
};

const INITIAL_DEV_SERVER_ERRORS_GLOBAL = "__VINEXT_INITIAL_DEV_ERRORS__";

function stringifyThrownValue(error: unknown): string {
  if (typeof error === "string") return error;
  try {
    return String(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

function createInitialDevServerErrorPayload(error: unknown): InitialDevServerErrorPayload {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name || undefined,
      stack: error.stack || undefined,
    };
  }

  return {
    message: stringifyThrownValue(error),
  };
}

export function createInitialDevServerErrorScript(
  error: unknown,
  scriptNonce?: string,
  nodeEnv = process.env.NODE_ENV,
): string {
  if (error == null || nodeEnv === "production") return "";

  const globalRef = "self[" + safeJsonStringify(INITIAL_DEV_SERVER_ERRORS_GLOBAL) + "]";
  const payload = safeJsonStringify(createInitialDevServerErrorPayload(error));
  return createInlineScriptTag(
    `${globalRef}=${globalRef}||[];${globalRef}.push(${payload})`,
    scriptNonce,
  );
}
