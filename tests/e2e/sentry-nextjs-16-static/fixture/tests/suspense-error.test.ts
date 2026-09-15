import { expect, test } from '@playwright/test';
import { waitForError, waitForTransaction } from '@sentry-internal/test-utils';

test('should not capture serverside suspense errors', async ({ page }) => {
  const pageServerComponentTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent?.transaction === 'GET /suspense-error';
  });

  let errorEvent;
  waitForError('nextjs-16-static', async errorEvent => {
    return errorEvent?.transaction === 'Page Server Component (/suspense-error)';
  }).then(event => {
    errorEvent = event;
  });

  await page.goto(`/suspense-error`);

  // Just to be a little bit more sure
  await page.waitForTimeout(5000);

  const pageServerComponentTransaction = await pageServerComponentTransactionPromise;
  expect(pageServerComponentTransaction).toBeDefined();

  expect(errorEvent).toBeUndefined();
});
