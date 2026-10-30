import { test } from "@playwright/test";
import {
  expectHostCaptureCannotRetargetProxy,
  expectPathCaptureStaysInDestination,
} from "../helpers";

test("a has capture in an external rewrite host cannot retarget the proxy", async ({ request }) => {
  await expectHostCaptureCannotRetargetProxy(request);
});

test("a has capture in an external rewrite path stays inside it", async ({ request }) => {
  await expectPathCaptureStaysInDestination(request);
});
