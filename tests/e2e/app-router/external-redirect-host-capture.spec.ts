import { test } from "@playwright/test";
import { expectHostCaptureCannotRetargetRedirect } from "../helpers";

test("a has capture in an external redirect host cannot retarget the Location", async ({
  request,
}) => {
  await expectHostCaptureCannotRetargetRedirect(request);
  // RSC navigations build their Location separately.
  await expectHostCaptureCannotRetargetRedirect(request, "", { RSC: "1" });
});
