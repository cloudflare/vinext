import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

// Ported from Next.js: test/development/app-dir/image-sizing-warning/image-sizing-warning.test.ts
// https://github.com/vercel/next.js/blob/canary/test/development/app-dir/image-sizing-warning/image-sizing-warning.test.ts
//
// Extra negative controls beyond the Next.js fixture: a zero-size image, and
// the production counterpart in app-router-prod/image-sizing-warning.spec.ts.

const ROUTE = "/nextjs-compat/image-sizing-warning";
const ASPECT_RATIO_WARNING =
  "is rendered with a different aspect ratio than its intrinsic dimensions. Adjust the width and height props, or use CSS 'width: \"auto\"' or 'height: \"auto\"' to preserve the aspect ratio. Read more: https://nextjs.org/docs/app/api-reference/components/image#style";

const DISTORTED_CASES = ["default", "fill", "fill-neighbor", "height-only", "props-stretched"];

function collectConsoleMessages(page: Page): string[] {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(message.text()));
  return messages;
}

function aspectRatioWarnings(messages: string[]): string[] {
  return messages.filter((message) => message.includes("aspect ratio"));
}

function warningCases(messages: string[]): string[] {
  return aspectRatioWarnings(messages)
    .map((message) => message.match(/\?case=([^"&\s]+)/)?.[1])
    .filter((value): value is string => Boolean(value))
    .sort();
}

async function waitForImagesLoaded(page: Page, count: number): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(
        (expected) =>
          document.images.length === expected &&
          Array.from(document.images).every((img) => img.dataset.loaded === "true"),
        count,
      ),
    )
    .toBe(true);
}

test.describe("next/image aspect-ratio warning (dev)", () => {
  test("warns about distortion while allowing cropping, source mismatches and rounding", async ({
    page,
  }) => {
    const messages = collectConsoleMessages(page);
    await page.goto(ROUTE);
    await waitForAppRouterHydration(page);
    await waitForImagesLoaded(page, 18);

    expect(
      await page.evaluate(() => {
        const img = document.getElementById("cover") as HTMLImageElement;
        const style = getComputedStyle(img);
        return {
          width: img.width,
          height: img.height,
          objectFit: style.objectFit,
          aspectRatio: style.aspectRatio,
        };
      }),
    ).toEqual({
      width: 680,
      height: 720,
      objectFit: "cover",
      aspectRatio: "17 / 18",
    });

    expect(
      await page.evaluate(() => {
        const img = document.getElementById("cover-neighbor") as HTMLImageElement;
        return [img.width, img.height];
      }),
    ).toEqual([681, 721]);

    expect(
      await page.evaluate(() => {
        const img = document.getElementById("source-mismatch") as HTMLImageElement;
        return [
          img.width,
          img.height,
          img.naturalWidth,
          img.naturalHeight,
          img.getAttribute("height"),
        ];
      }),
    ).toEqual([820, 720, 820, 720, "700"]);

    expect(
      await page.evaluate(() => {
        const img = document.getElementById("fractional") as HTMLImageElement;
        return [img.width, img.height, getComputedStyle(img).height];
      }),
    ).toEqual([75, 38, "37.5px"]);

    expect(
      await page.evaluate(() =>
        ["fractional-wide", "fractional-tall"].map((id) => {
          const img = document.getElementById(id) as HTMLImageElement;
          return [img.width, img.height];
        }),
      ),
    ).toEqual([
      [75, 8],
      [8, 75],
    ]);

    const densityRounded = await page.evaluate(() => {
      const img = document.getElementById("density-rounded") as HTMLImageElement;
      return {
        width: img.width,
        height: img.height,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      };
    });
    expect([densityRounded.width, densityRounded.height]).toEqual([1640, 1440]);

    expect(
      await page.evaluate(() => {
        const img = document.getElementById("zero") as HTMLImageElement;
        return [img.width, img.height];
      }),
    ).toEqual([0, 0]);

    const warnings = aspectRatioWarnings(messages);
    expect(warningCases(messages)).toEqual(DISTORTED_CASES);
    expect(warnings.every((message) => message.includes(ASPECT_RATIO_WARNING))).toBe(true);
    expect(warningCases(messages)).not.toContain("zero");
    expect(warningCases(messages)).not.toContain("fill-prop");
    expect(warningCases(messages)).not.toContain("cover");
    expect(warningCases(messages)).not.toContain("contain");
    expect(warningCases(messages)).not.toContain("proportional");
  });
});
