// Ported from next-intl: examples/example-app-router-playground/tests/utils.ts
// https://github.com/amannn/next-intl/blob/main/examples/example-app-router-playground/tests/utils.ts
import {APIResponse, Page, expect, test} from '@playwright/test';

// vinext: upstream's playwright config exports its server port as
// `process.env.PORT`. The vinext config runs several projects in one process, so
// read the port from the current project's baseURL instead.
export function getPort() {
  return new URL(test.info().project.use.baseURL!).port;
}

export async function getAlternateLinks(response: APIResponse) {
  return (
    response
      .headers()
      .link.split(', ')
      // On CI, Playwright uses a different host somehow
      .map((cur) => cur.replace(/0\.0\.0\.0/g, 'localhost'))
      // Normalize ports
      .map((cur) => cur.replace(/localhost:\d{4}/g, 'localhost:3000'))
  );
}

export async function assertLocaleCookieValue(
  page: Page,
  value?: string,
  otherProps?: Record<string, unknown>
) {
  const cookie = (await page.context().cookies()).find(
    (cur) => cur.name === 'NEXT_LOCALE'
  );
  if (value) {
    expect(cookie).toMatchObject({
      name: 'NEXT_LOCALE',
      value,
      ...otherProps
    });
  } else {
    expect(cookie).toBeUndefined();
  }
}
