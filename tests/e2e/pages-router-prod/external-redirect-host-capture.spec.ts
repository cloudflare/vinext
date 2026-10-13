import { test } from "@playwright/test";
import { expectHostCaptureCannotRetargetRedirect } from "../helpers";

test("a has capture in an external redirect host cannot retarget the Location", async ({
  baseURL,
  request,
}) => {
  await expectHostCaptureCannotRetargetRedirect(request, baseURL ?? "http://localhost:4175");
});
