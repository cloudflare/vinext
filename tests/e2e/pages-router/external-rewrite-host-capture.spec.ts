import { test } from "@playwright/test";
import { expectHostCaptureCannotRetargetProxy } from "../helpers";

test("a has capture in an external rewrite host cannot retarget the proxy", async ({ request }) => {
  await expectHostCaptureCannotRetargetProxy(request);
});
