import { expect, test } from '@playwright/test';
import { waitForTransaction } from '@sentry-internal/test-utils';

test('should remove sentry-trace and baggage meta tags on ISR dynamic route page load', async ({ page }) => {
  // Navigate to ISR page
  await page.goto('/isr-test/laptop');

  // Wait for page to be fully loaded
  await expect(page.locator('#isr-product-id')).toHaveText('laptop');

  // Check that sentry-trace and baggage meta tags are removed for ISR pages
  await expect(page.locator('meta[name="sentry-trace"]')).toHaveCount(0);
  await expect(page.locator('meta[name="baggage"]')).toHaveCount(0);
});

test('should remove sentry-trace and baggage meta tags on ISR static route', async ({ page }) => {
  // Navigate to ISR static page
  await page.goto('/isr-test/static');

  // Wait for page to be fully loaded
  await expect(page.locator('#isr-static-marker')).toHaveText('static-isr');

  // Check that sentry-trace and baggage meta tags are removed for ISR pages
  await expect(page.locator('meta[name="sentry-trace"]')).toHaveCount(0);
  await expect(page.locator('meta[name="baggage"]')).toHaveCount(0);
});

test('should remove meta tags for different ISR dynamic route values', async ({ page }) => {
  // Test with 'phone' (one of the pre-generated static params)
  await page.goto('/isr-test/phone');
  await expect(page.locator('#isr-product-id')).toHaveText('phone');

  await expect(page.locator('meta[name="sentry-trace"]')).toHaveCount(0);
  await expect(page.locator('meta[name="baggage"]')).toHaveCount(0);

  // Test with 'tablet'
  await page.goto('/isr-test/tablet');
  await expect(page.locator('#isr-product-id')).toHaveText('tablet');

  await expect(page.locator('meta[name="sentry-trace"]')).toHaveCount(0);
  await expect(page.locator('meta[name="baggage"]')).toHaveCount(0);
});

test('should create unique transactions for ISR pages on each visit', async ({ page }) => {
  const traceIds: string[] = [];

  // Load the same ISR page 5 times to ensure cached HTML meta tags are consistently removed
  for (let i = 0; i < 5; i++) {
    const transactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
      return !!(
        transactionEvent.transaction === '/isr-test/:product' && transactionEvent.contexts?.trace?.op === 'pageload'
      );
    });

    if (i === 0) {
      await page.goto('/isr-test/laptop');
    } else {
      await page.reload();
    }

    const transaction = await transactionPromise;
    const traceId = transaction.contexts?.trace?.trace_id;

    expect(traceId).toBeDefined();
    expect(traceId).toMatch(/[a-f0-9]{32}/);
    traceIds.push(traceId!);
  }

  // Verify all 5 page loads have unique trace IDs (no reuse of cached/stale meta tags)
  const uniqueTraceIds = new Set(traceIds);
  expect(uniqueTraceIds.size).toBe(5);
});

test('ISR route should be identified correctly in the route manifest', async ({ page }) => {
  const transactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent.transaction === '/isr-test/:product' && transactionEvent.contexts?.trace?.op === 'pageload';
  });

  await page.goto('/isr-test/laptop');
  const transaction = await transactionPromise;

  // Verify the transaction is properly parameterized
  expect(transaction).toMatchObject({
    transaction: '/isr-test/:product',
    transaction_info: { source: 'route' },
    contexts: {
      trace: {
        data: {
          'sentry.segment.name.source': 'route',
        },
      },
    },
  });
});
