import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  getReactNodeEnv,
  importReactDomServerEdge,
} from "../packages/vinext/src/server/react-renderer-env.js";

describe("getReactNodeEnv", () => {
  it("classifies a getOwner-carrying createElement as development", () => {
    expect(getReactNodeEnv(() => "uses getOwner internally")).toBe("development");
  });

  it("classifies a stripped createElement as production", () => {
    expect(getReactNodeEnv(() => "no owner tracking")).toBe("production");
  });

  it("classifies the actually-loaded React runtime", () => {
    const env = getReactNodeEnv(React.createElement);
    expect(env === "development" || env === "production").toBe(true);
  });
});

describe("importReactDomServerEdge", () => {
  // `process.env.NODE_ENV` is typed read-only under the test tsconfig; mutate
  // through a mutable view, the same shape the loader narrows it to.
  const procEnv = process.env as Record<string, string | undefined>;
  const original = procEnv.NODE_ENV;
  afterEach(() => {
    if (original === undefined) {
      delete procEnv.NODE_ENV;
    } else {
      procEnv.NODE_ENV = original;
    }
  });

  it("loads the server renderer", async () => {
    const mod = await importReactDomServerEdge(getReactNodeEnv(React.createElement));
    expect(typeof mod.renderToReadableStream).toBe("function");
  });

  it("leaves NODE_ENV untouched on the fast path (already matching)", async () => {
    procEnv.NODE_ENV = "production";
    await importReactDomServerEdge("production");
    expect(procEnv.NODE_ENV).toBe("production");
  });

  it("restores a defined NODE_ENV after realigning for a mismatch", async () => {
    procEnv.NODE_ENV = "renderer-env-sentinel";
    await importReactDomServerEdge("production");
    expect(procEnv.NODE_ENV).toBe("renderer-env-sentinel");
  });

  it("restores NODE_ENV to undefined when it was unset before the mismatch", async () => {
    delete procEnv.NODE_ENV;
    await importReactDomServerEdge("production");
    expect(procEnv.NODE_ENV).toBeUndefined();
  });
});
