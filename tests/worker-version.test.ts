import { describe, expect, it } from "vite-plus/test";
import {
  VINEXT_VERSION_METADATA_BINDING,
  VINEXT_WORKER_VERSION_HEADER,
  stampWorkerVersion,
} from "../packages/vinext/src/server/worker-version.js";

describe("Worker version response metadata", () => {
  it("overwrites an application header with the platform version ID", async () => {
    const response = stampWorkerVersion(
      new Response("new html", {
        headers: { [VINEXT_WORKER_VERSION_HEADER]: "application-value" },
      }),
      {
        [VINEXT_VERSION_METADATA_BINDING]: {
          id: "22222222-2222-4222-8222-222222222222",
          tag: "",
          timestamp: "2026-07-11T00:00:00.000Z",
        },
      },
    );

    expect(response.headers.get(VINEXT_WORKER_VERSION_HEADER)).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(await response.text()).toBe("new html");
  });

  it("leaves the response unchanged without a version metadata binding", () => {
    const response = new Response("html");
    expect(stampWorkerVersion(response, {})).toBe(response);
  });

  it("does not guess a version binding from application metadata", () => {
    const response = new Response("html");
    expect(
      stampWorkerVersion(response, {
        APP_RELEASE: {
          id: "application-release",
          tag: "production",
          timestamp: "2026-07-11T00:00:00.000Z",
        },
      }),
    ).toBe(response);
    expect(response.headers.get(VINEXT_WORKER_VERSION_HEADER)).toBeNull();
  });

  it("clones a response whose headers are immutable", async () => {
    const source = Response.redirect("https://example.com/next", 302);
    const response = stampWorkerVersion(source, {
      [VINEXT_VERSION_METADATA_BINDING]: {
        id: "22222222-2222-4222-8222-222222222222",
        tag: "",
        timestamp: "2026-07-11T00:00:00.000Z",
      },
    });

    expect(response).not.toBe(source);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/next");
    expect(response.headers.get(VINEXT_WORKER_VERSION_HEADER)).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("does not throw when a response cannot be reconstructed", () => {
    const response = Response.error();
    expect(
      stampWorkerVersion(response, {
        [VINEXT_VERSION_METADATA_BINDING]: {
          id: "22222222-2222-4222-8222-222222222222",
          tag: "",
          timestamp: "2026-07-11T00:00:00.000Z",
        },
      }),
    ).toBe(response);
  });
});
