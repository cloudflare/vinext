import test, { expect } from '@playwright/test';
import { waitForError } from '@sentry-internal/test-utils';
import { isTurbopackDevMode } from './isDevMode';

// Regression test for https://github.com/getsentry/sentry-javascript/issues/23176
//
// Under `next dev` with Turbopack, server stack frames get their `in_app` classification inverted:
// Turbopack names vendor chunks `node_modules_<pkg>_<hash>.js` (underscores, no `node_modules/`
// segment) and prefixes app modules with `[project]/`. `filenameIsInApp` keys off a literal
// `node_modules/` substring and treats bracket-prefixed paths as internal, so vendor code is
// marked `in_app: true` and the real app crash site is marked `in_app: false`.
test('Turbopack dev: server stack frames are classified in_app correctly', async ({ page }) => {
  test.skip(
    !isTurbopackDevMode,
    'Turbopack chunk naming (node_modules_ / [project]) only occurs in Turbopack dev mode',
  );

  const errorPromise = waitForError('nextjs-16-static', errorEvent => {
    return !!errorEvent?.exception?.values?.some(value => value.value?.includes('Tool call failed'));
  });

  await page.goto('/ai-error-test');

  const errorEvent = await errorPromise;

  const frames = errorEvent.exception?.values?.flatMap(value => value.stacktrace?.frames ?? []) ?? [];
  expect(frames.length).toBeGreaterThan(0);

  // The crash site is app code: the `execute` tool callback defined in `app/ai-error-test/page.tsx`.
  // It must be `in_app` so the issue leads with the real crash frame instead of vendor code.
  const appFrame = frames.find(frame => frame.filename?.includes('ai-error-test'));
  expect(
    appFrame,
    `expected an app frame for the route file, got: ${JSON.stringify(frames.map(frame => frame.filename))}`,
  ).toBeDefined();
  expect(appFrame?.in_app).toBe(true);

  // Vendor frames from the `ai` package (Turbopack: `...node_modules_ai_...`) must not be `in_app`.
  const vendorFrames = frames.filter(frame => frame.filename?.includes('node_modules'));
  for (const vendorFrame of vendorFrames) {
    expect(vendorFrame.in_app, `vendor frame ${vendorFrame.filename} should not be in_app`).toBe(false);
  }
});
