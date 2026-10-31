import { test, expect } from "@playwright/test";
import { getWithHost } from "../helpers";

// tests/fixtures/app-router-nitro-server built with `vite build` and served by
// Nitro's Node server.

test.describe("App Router on Nitro (node server)", () => {
  // `vinext start` 404s a request target that is not origin-form, and Next.js
  // never routes one. Nitro's Node server takes request.url's origin from an
  // absolute-form target, also when h3 decodes its path back into req.url.
  test("doesn't route an absolute-form request target", async ({ baseURL }) => {
    const host = new URL(baseURL!).host;
    const control = await getWithHost(baseURL!, "/hello.txt", host);
    expect({ status: control.status, body: control.body }).toEqual({
      status: 200,
      body: "Hello from public/\n",
    });

    for (const target of [
      "http://other.example/",
      "http://other.example/hello.txt",
      // h3 decodes a path with a `%` back into req.url.
      "https://other.example/%61",
      `http://${host}/hello.txt`,
    ]) {
      const response = await getWithHost(baseURL!, target, host);
      expect({ status: response.status, body: response.body }, target).toEqual({
        status: 404,
        body: "This page could not be found",
      });
    }
  });
});
