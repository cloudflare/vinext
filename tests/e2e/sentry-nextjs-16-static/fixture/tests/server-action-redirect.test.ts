import { expect, test } from '@playwright/test';
import { waitForError, waitForTransaction } from '@sentry-internal/test-utils';

test('Should handle server action redirect without capturing errors', async ({ page }) => {
  // Wait for the initial page load transaction
  const pageLoadTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent?.transaction === '/redirect/origin';
  });

  // Navigate to the origin page
  await page.goto('/redirect/origin');

  const pageLoadTransaction = await pageLoadTransactionPromise;
  expect(pageLoadTransaction).toBeDefined();

  // Wait for the redirect transaction
  const redirectTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent?.transaction === 'GET /redirect/destination';
  });

  // No error should be captured
  const redirectErrorPromise = waitForError('nextjs-16-static', async errorEvent => {
    return !!errorEvent;
  });

  // Click the redirect button
  await page.click('button[type="submit"]');

  await redirectTransactionPromise;

  // Verify we got redirected to the destination page
  await expect(page).toHaveURL('/redirect/destination');

  // Wait for potential errors with a 2 second timeout
  const errorTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('No error captured (timeout)')), 2000),
  );

  // We expect this to timeout since no error should be captured during the redirect
  try {
    await Promise.race([redirectErrorPromise, errorTimeout]);
    throw new Error('Expected no error to be captured, but an error was found');
  } catch (e) {
    // If we get a timeout error (as expected), no error was captured
    expect((e as Error).message).toBe('No error captured (timeout)');
  }
});
