import { expect, it, vi } from "vite-plus/test";
import { validateResponseStoreLocationHint } from "../packages/workers-response-store/src/binding.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

it("rejects non-string location hints that coerce to supported names", () => {
  expect(() => validateResponseStoreLocationHint(["weur"])).toThrow(
    "Workers Response Store locationHint is not supported by Cloudflare",
  );
});
