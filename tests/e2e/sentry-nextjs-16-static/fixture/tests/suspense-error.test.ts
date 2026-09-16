import { expect, test } from '@playwright/test';
import { expectNoError, waitForTransaction } from './test-utils';

test('should not capture serverside suspense errors', async ({ page }) => {
  const pageServerComponentTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent?.transaction === 'GET /suspense-error';
  });

  const noErrorPromise = expectNoError('nextjs-16-static', async errorEvent => {
    return errorEvent?.transaction === 'Page Server Component (/suspense-error)';
  }, 5000);

  await page.goto(`/suspense-error`);

  const pageServerComponentTransaction = await pageServerComponentTransactionPromise;
  await noErrorPromise;
  expect(pageServerComponentTransaction).toBeDefined();
});
