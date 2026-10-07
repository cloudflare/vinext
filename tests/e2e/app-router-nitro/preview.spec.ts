import { test } from "@playwright/test";
import { defineNitroAppTests } from "./app-tests";

// examples/app-router-nitro built with `vite build` and served by
// `vite preview`, which runs Nitro's own server output (#853).

test.describe("App Router on Nitro (vite preview)", () => {
  defineNitroAppTests();
});
