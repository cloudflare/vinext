import { describe, expect, it } from "vite-plus/test";
import { getProperError } from "../packages/vinext/src/server/proper-error.js";
import { withEnvVar } from "./env-test-helpers.js";

// Ported from Next.js: packages/next/src/lib/is-error.ts
// https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/lib/is-error.ts
describe("getProperError", () => {
  it("returns Error-like values unchanged", () => {
    const error = new Error("boom");
    const errorLike = { name: "CustomError", message: "custom" };

    expect(getProperError(error)).toBe(error);
    expect(getProperError(errorLike)).toBe(errorLike);
  });

  it("stringifies plain objects, replacing circular references", () => {
    const value: Record<string, unknown> = { code: "DB_CONNECTION_FAILED" };
    value.self = value;

    expect(getProperError(value).message).toBe(
      '{"code":"DB_CONNECTION_FAILED","self":"[Circular]"}',
    );
    expect(getProperError(Object.create(null)).message).toBe("{}");
  });

  it("stringifies other values", () => {
    expect(getProperError(0).message).toBe("0");
    expect(getProperError(new Map()).message).toBe("[object Map]");
  });

  it("explains thrown null and undefined in development", async () => {
    await withEnvVar("NODE_ENV", "development", async () => {
      expect(getProperError(undefined).message).toBe(
        "An undefined error was thrown, see here for more info: https://nextjs.org/docs/messages/threw-undefined",
      );
      expect(getProperError(null).message).toBe(
        "A null error was thrown, see here for more info: https://nextjs.org/docs/messages/threw-undefined",
      );
    });
    await withEnvVar("NODE_ENV", "production", async () => {
      expect(getProperError(undefined).message).toBe("undefined");
      expect(getProperError(null).message).toBe("null");
    });
  });
});
