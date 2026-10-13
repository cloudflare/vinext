import { describe, expect, it, vi } from "vite-plus/test";
import { createLiveNavigationFetch } from "../packages/vinext/src/server/app-browser-navigation-response.js";

describe("live navigation fetch", () => {
  it("issues the request when started, before the navigation awaits it", async () => {
    const response = new Response("flight");
    const fetchResponse = vi.fn(() => Promise.resolve(response));
    const liveFetch = createLiveNavigationFetch(fetchResponse);

    liveFetch.start();
    expect(fetchResponse).toHaveBeenCalledTimes(1);

    liveFetch.start();
    await expect(liveFetch.take()).resolves.toBe(response);
    expect(fetchResponse).toHaveBeenCalledTimes(1);
  });

  it("issues the request lazily, at most once, when it was never started", async () => {
    const response = new Response("flight");
    const fetchResponse = vi.fn(() => Promise.resolve(response));
    const liveFetch = createLiveNavigationFetch(fetchResponse);

    expect(fetchResponse).not.toHaveBeenCalled();
    await expect(liveFetch.take()).resolves.toBe(response);
    expect(fetchResponse).toHaveBeenCalledTimes(1);

    liveFetch.start();
    await expect(liveFetch.take()).resolves.toBe(response);
    expect(fetchResponse).toHaveBeenCalledTimes(1);
  });

  it("does not report an unhandled rejection when a started request is abandoned", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const controller = new AbortController();
      const liveFetch = createLiveNavigationFetch(
        () =>
          new Promise<Response>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => reject(controller.signal.reason));
          }),
      );

      liveFetch.start();
      // A superseding navigation aborts the request; this one never calls take().
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("surfaces a started request's rejection to take()", async () => {
    const error = new Error("network");
    const liveFetch = createLiveNavigationFetch(() => Promise.reject(error));

    liveFetch.start();

    await expect(liveFetch.take()).rejects.toBe(error);
  });
});
