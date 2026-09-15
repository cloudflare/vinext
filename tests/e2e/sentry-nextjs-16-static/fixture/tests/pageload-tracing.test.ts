import { expect, test } from '@playwright/test';
import { waitForTransaction } from '@sentry-internal/test-utils';

test('App router transactions should be attached to the pageload request span', async ({ page }) => {
  const serverTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent?.transaction === 'GET /pageload-tracing';
  });

  const pageloadTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent?.transaction === '/pageload-tracing';
  });

  await page.goto(`/pageload-tracing`);

  const [serverTransaction, pageloadTransaction] = await Promise.all([
    serverTransactionPromise,
    pageloadTransactionPromise,
  ]);

  const pageloadTraceId = pageloadTransaction.contexts?.trace?.trace_id;

  expect(pageloadTraceId).toBeTruthy();
  expect(serverTransaction.contexts?.trace?.trace_id).toBe(pageloadTraceId);
});

test('extracts HTTP request headers as span attributes', async ({ baseURL }) => {
  const serverTransactionPromise = waitForTransaction('nextjs-16-static', async transactionEvent => {
    return transactionEvent?.transaction === 'GET /pageload-tracing';
  });

  await fetch(`${baseURL}/pageload-tracing`, {
    headers: {
      'User-Agent': 'Custom-NextJS-Agent/15.0',
      'Content-Type': 'text/html',
      'X-NextJS-Test': 'nextjs-header-value',
      Accept: 'text/html, application/xhtml+xml',
      'X-Framework': 'Next.js',
      'X-Request-ID': 'nextjs-789',
    },
  });

  const serverTransaction = await serverTransactionPromise;

  expect(serverTransaction.contexts?.trace?.data).toEqual(
    expect.objectContaining({
      'http.request.header.user-agent': 'Custom-NextJS-Agent/15.0',
      'http.request.header.content-type': 'text/html',
      'http.request.header.x-nextjs-test': 'nextjs-header-value',
      'http.request.header.accept': 'text/html, application/xhtml+xml',
      'http.request.header.x-framework': 'Next.js',
      'http.request.header.x-request-id': 'nextjs-789',
    }),
  );
});
